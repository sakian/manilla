/**
 * Taking your data out (NF-6).
 *
 * Two shapes, for two different reasons. JSON is the whole ledger with its
 * structure intact - every transaction with its envelope lines and the bank ids
 * it has collected - so nothing is lost and it could be read back. CSV is one
 * file per thing, flat, for a spreadsheet or another budgeting app, where a
 * split has to become one row per envelope share because that is the only shape
 * a spreadsheet understands.
 *
 * What is deliberately *not* exported: passkeys, sessions and recovery codes.
 * They are credentials, not data about your money, and writing them into a file
 * that gets emailed to yourself would undo the reason NF-3 exists.
 */

import { asc, notInArray } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import {
  accountGroups,
  accounts,
  appSettings,
  auditLog,
  budgetLines,
  envelopeGroups,
  envelopeMoves,
  envelopes,
  importBatches,
  rules,
  transactionExternalIds,
  transactionMessages,
  transactions,
  txnLines,
} from '../../db/schema.ts';
import { toCsv } from '../csv.ts';
import { ensureIncomePool } from '../ledger/ledger.ts';
import { AI_BUDGET_KEY, AI_ENABLED_KEY } from '../ai/ai.ts';
import { HOME_LEDGER_NAME_KEY } from '../ledgers/config.ts';
import { localToday } from '../budget/month.ts';

export type ExportedTransaction = {
  id: string;
  date: string;
  account: string;
  payee: string;
  payeeRaw: string;
  memo: string | null;
  /** What the household wrote about it, oldest first (src/transactions/thread.ts). */
  messages: { author: string | null; body: string; at: string }[];
  checkNumber: string | null;
  amountCents: number;
  kind: string;
  status: string;
  source: string;
  transferPairId: string | null;
  lines: { envelope: string; group: string; amountCents: number }[];
  externalIds: { kind: string; value: string }[];
};

export type LedgerExport = {
  exportedAt: string;
  /** What produced it, so a file found in three years explains itself. */
  application: string;
  counts: Record<string, number>;
  accounts: Record<string, unknown>[];
  envelopeGroups: Record<string, unknown>[];
  envelopes: Record<string, unknown>[];
  transactions: ExportedTransaction[];
  envelopeMoves: Record<string, unknown>[];
  budgetLines: Record<string, unknown>[];
  rules: Record<string, unknown>[];
  importBatches: Record<string, unknown>[];
  settings: Record<string, string>;
  /** Every change and deletion of a money row, oldest first (NF-2). */
  auditLog: Record<string, unknown>[];
};

/** Everything, with its structure: splits stay attached to their transaction. */
export async function exportLedger(db: Database): Promise<LedgerExport> {
  const [
    accountRows,
    groupRows,
    envelopeRows,
    transactionRows,
    lineRows,
    externalIdRows,
    messageRows,
    moveRows,
    budgetRows,
    ruleRows,
    batchRows,
    settingRows,
    auditRows,
  ] = await Promise.all([
    db.select().from(accounts).orderBy(asc(accounts.position), asc(accounts.name)),
    db.select().from(envelopeGroups).orderBy(asc(envelopeGroups.position)),
    db.select().from(envelopes).orderBy(asc(envelopes.name)),
    db.select().from(transactions).orderBy(asc(transactions.date), asc(transactions.createdAt)),
    db.select().from(txnLines),
    db.select().from(transactionExternalIds),
    db.select().from(transactionMessages).orderBy(asc(transactionMessages.createdAt), asc(transactionMessages.id)),
    db.select().from(envelopeMoves).orderBy(asc(envelopeMoves.date)),
    db.select().from(budgetLines),
    db.select().from(rules).orderBy(asc(rules.position)),
    db.select().from(importBatches).orderBy(asc(importBatches.createdAt)),
    db.select().from(appSettings),
    db.select().from(auditLog).orderBy(asc(auditLog.id)),
  ]);

  const accountNames = new Map(accountRows.map((row) => [row.id, row.name]));
  const groupNames = new Map(groupRows.map((row) => [row.id, row.name]));
  const envelopeById = new Map(envelopeRows.map((row) => [row.id, row]));

  const linesByTransaction = new Map<string, ExportedTransaction['lines']>();
  for (const line of lineRows) {
    const envelope = envelopeById.get(line.envelopeId);
    const list = linesByTransaction.get(line.transactionId) ?? [];
    list.push({
      envelope: envelope?.name ?? 'unknown',
      group: envelope ? (groupNames.get(envelope.groupId) ?? '') : '',
      amountCents: Number(line.amountCents),
    });
    linesByTransaction.set(line.transactionId, list);
  }

  const messagesByTransaction = new Map<string, ExportedTransaction['messages']>();
  for (const message of messageRows) {
    const list = messagesByTransaction.get(message.transactionId) ?? [];
    list.push({ author: message.authorName, body: message.body, at: message.createdAt.toISOString() });
    messagesByTransaction.set(message.transactionId, list);
  }

  const idsByTransaction = new Map<string, ExportedTransaction['externalIds']>();
  for (const external of externalIdRows) {
    const list = idsByTransaction.get(external.transactionId) ?? [];
    list.push({ kind: external.kind, value: external.value });
    idsByTransaction.set(external.transactionId, list);
  }

  const exported: ExportedTransaction[] = transactionRows.map((row) => ({
    id: row.id,
    date: row.date,
    account: accountNames.get(row.accountId) ?? 'unknown',
    payee: row.payeeKey,
    payeeRaw: row.payeeRaw,
    memo: row.memo,
    messages: messagesByTransaction.get(row.id) ?? [],
    checkNumber: row.checkNumber,
    amountCents: Number(row.amountCents),
    kind: row.kind,
    status: row.status,
    source: row.source,
    transferPairId: row.transferPairId,
    lines: linesByTransaction.get(row.id) ?? [],
    externalIds: idsByTransaction.get(row.id) ?? [],
  }));

  return {
    exportedAt: new Date().toISOString(),
    application: 'Manilla',
    counts: {
      accounts: accountRows.length,
      envelopes: envelopeRows.length,
      transactions: transactionRows.length,
      envelopeLines: lineRows.length,
      envelopeMoves: moveRows.length,
      budgetLines: budgetRows.length,
      rules: ruleRows.length,
      auditEntries: auditRows.length,
    },
    accounts: accountRows,
    envelopeGroups: groupRows,
    envelopes: envelopeRows.map((row) => ({
      ...row,
      group: groupNames.get(row.groupId) ?? '',
    })),
    transactions: exported,
    envelopeMoves: moveRows.map((row) => ({
      ...row,
      amountCents: Number(row.amountCents),
      fromEnvelope: envelopeById.get(row.fromEnvelopeId)?.name ?? 'unknown',
      toEnvelope: envelopeById.get(row.toEnvelopeId)?.name ?? 'unknown',
    })),
    budgetLines: budgetRows.map((row) => ({
      ...row,
      plannedCents: Number(row.plannedCents),
      envelope: envelopeById.get(row.envelopeId)?.name ?? 'unknown',
    })),
    rules: ruleRows.map((row) => ({
      ...row,
      envelope: row.envelopeId ? (envelopeById.get(row.envelopeId)?.name ?? '') : '',
      transferAccount: row.transferAccountId
        ? (accountNames.get(row.transferAccountId) ?? '')
        : '',
    })),
    importBatches: batchRows,
    settings: Object.fromEntries(settingRows.map((row) => [row.key, row.value])),
    auditLog: auditRows,
  };
}

export const CSV_TABLES = [
  'transactions',
  'envelopes',
  'accounts',
  'moves',
  'budget',
  'rules',
] as const;

export type CsvTableName = (typeof CSV_TABLES)[number];

export function isCsvTable(value: string): value is CsvTableName {
  return (CSV_TABLES as readonly string[]).includes(value);
}

/**
 * One table, flat.
 *
 * A split transaction becomes one row per envelope share, with the transaction's
 * own total repeated: that is what a spreadsheet can sum by envelope, and the
 * shared id is what lets the rows be put back together. Amounts are written as
 * decimal strings because a spreadsheet will read cents as whole dollars given
 * the chance.
 */
export async function exportCsv(db: Database, table: CsvTableName): Promise<string> {
  const ledger = await exportLedger(db);
  const amount = (cents: number) => (cents / 100).toFixed(2);

  switch (table) {
    case 'transactions': {
      const rows = ledger.transactions.flatMap((transaction) => {
        const shared = {
          id: transaction.id,
          date: transaction.date,
          account: transaction.account,
          payee: transaction.payeeRaw,
          memo: transaction.memo ?? '',
          // The thread in one cell, a line each, so a spreadsheet keeps who said what.
          note: transaction.messages
            .map((message) => (message.author ? `${message.author}: ${message.body}` : message.body))
            .join('\n'),
          amount: amount(transaction.amountCents),
          kind: transaction.kind,
          status: transaction.status,
          source: transaction.source,
        };

        if (transaction.lines.length === 0) {
          return [{ ...shared, envelope: '', group: '', envelopeAmount: '' }];
        }

        return transaction.lines.map((line) => ({
          ...shared,
          envelope: line.envelope,
          group: line.group,
          envelopeAmount: amount(line.amountCents),
        }));
      });

      return toCsv(rows, [
        'id',
        'date',
        'account',
        'payee',
        'memo',
        'note',
        'amount',
        'envelope',
        'group',
        'envelopeAmount',
        'kind',
        'status',
        'source',
      ]);
    }

    case 'envelopes':
      return toCsv(
        ledger.envelopes.map((envelope) => ({
          name: envelope.name,
          group: envelope.group,
          carryOver: envelope.carryOver,
          mayGoNegative: envelope.mayGoNegative,
          isIncomePool: envelope.isUnallocated,
          archived: envelope.archivedAt ? 'yes' : 'no',
        })),
        ['name', 'group', 'carryOver', 'mayGoNegative', 'isIncomePool', 'archived'],
      );

    case 'accounts':
      return toCsv(
        ledger.accounts.map((account) => ({
          name: account.name,
          kind: account.kind,
          currency: account.currency,
          bankAccountNumber: account.externalAccountId ?? '',
          archived: account.archivedAt ? 'yes' : 'no',
        })),
        ['name', 'kind', 'currency', 'bankAccountNumber', 'archived'],
      );

    case 'moves':
      return toCsv(
        ledger.envelopeMoves.map((move) => ({
          date: move.date,
          from: move.fromEnvelope,
          to: move.toEnvelope,
          amount: amount(move.amountCents as number),
          kind: move.kind,
          note: move.note ?? '',
        })),
        ['date', 'from', 'to', 'amount', 'kind', 'note'],
      );

    case 'budget':
      return toCsv(
        ledger.budgetLines.map((line) => ({
          envelope: line.envelope,
          month: line.month ?? 'default',
          planned: amount(line.plannedCents as number),
        })),
        ['envelope', 'month', 'planned'],
      );

    case 'rules':
      return toCsv(
        ledger.rules.map((rule) => ({
          matches: rule.contains,
          envelope: rule.envelope,
          transferTo: rule.transferAccount,
          minAmount: rule.minCents === null ? '' : amount(Number(rule.minCents)),
          maxAmount: rule.maxCents === null ? '' : amount(Number(rule.maxCents)),
        })),
        ['matches', 'envelope', 'transferTo', 'minAmount', 'maxAmount'],
      );
  }
}

/**
 * NF-6's other half: remove everything about your money, and keep the way in.
 *
 * Passkeys and sessions survive deliberately. "Delete everything" here means the
 * ledger, not the account - someone clearing their data to start again should
 * not also be locked out of the app they are still using. Signing out
 * everywhere is a separate button that already exists.
 *
 * `ai_calls` survives too, for a different reason: it is a record of money spent
 * with a third party, not a record of your money, and a spend log that can be
 * cleared by the thing doing the spending is not much of a log. So do the AI
 * switch and budget, which belong to the account and cover every ledger (LG-5),
 * and the list of ledgers with the home one's name: erasing one ledger's money
 * is not closing the others.
 *
 * Every other table goes, and the list has to be kept in step with the schema -
 * `account_groups` was missed when it was added, which left a set of empty
 * categories behind after an erase with nothing to say where they came from.
 *
 * What is left is what a fresh install has: an empty income pool.
 */
export async function eraseAllData(db: Database): Promise<Record<string, number>> {
  const before = {
    transactions: (await db.select({ id: transactions.id }).from(transactions)).length,
    envelopes: (await db.select({ id: envelopes.id }).from(envelopes)).length,
    accounts: (await db.select({ id: accounts.id }).from(accounts)).length,
  };

  await db.transaction(async (tx) => {
    // Order matters only where a foreign key would complain; the children go
    // first and the rest follows.
    await tx.delete(txnLines);
    await tx.delete(transactionExternalIds);
    await tx.delete(envelopeMoves);
    await tx.delete(budgetLines);
    await tx.delete(rules);
    await tx.delete(transactions);
    await tx.delete(importBatches);
    await tx.delete(envelopes);
    await tx.delete(envelopeGroups);
    await tx.delete(accounts);
    await tx.delete(accountGroups);
    await tx
      .delete(appSettings)
      .where(notInArray(appSettings.key, [AI_ENABLED_KEY, AI_BUDGET_KEY, HOME_LEDGER_NAME_KEY]));
    // Last, because every delete above was itself written into it (NF-2): an
    // erase that left a row-by-row copy of what it erased would be no erase.
    await tx.delete(auditLog);
    // The one envelope an empty ledger still needs: without it every budget
    // screen throws, which is not "starting again" (#21).
    await ensureIncomePool(tx);
  });

  return before;
}

/**
 * A filename that says what it is and when it was taken - and, when there is
 * more than one ledger, whose: two downloads called manilla-ledger-<day>.json
 * from different books are a mix-up waiting to happen (LG-1).
 */
export function exportFilename(kind: string, now: Date = new Date(), ledger?: string): string {
  const stamp = localToday(now);
  const whose = ledger
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `manilla-${whose ? `${whose}-` : ''}${kind}-${stamp}`;
}
