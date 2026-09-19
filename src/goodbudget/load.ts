/**
 * GoodBudget export loader (MG-1 to MG-5).
 *
 * Verified against a real 7,957-row, six-year export. Three things that export
 * taught us, each of which would have corrupted the migration silently:
 *
 *  1. Dates are D/M/Y, not the M/D/Y a North American file suggests. The format
 *     is therefore decided once for the whole file from rows that can only be
 *     read one way (a first component above 12), never guessed per row.
 *  2. Splits live in the `Details` column as `Envelope|Amount` pairs separated
 *     by `||`, on a parent row whose own `Envelope` is blank.
 *  3. Income arrives as a split into the pseudo-envelope `[Available]`, which is
 *     GoodBudget's unallocated pool - the Income envelope of FR-28.
 */

import { parseCsv, detectDelimiter, toRecords } from '../csv.ts';
import { parseAmount } from '../money.ts';
import type { LabeledTransaction } from '../categorize/types.ts';

/** GoodBudget's unallocated pool, equivalent to Manilla's Income envelope. */
export const AVAILABLE = '[Available]';

/** Candidate header names per field, lowercased, most specific first. */
const ALIASES = {
  date: ['date', 'transaction date', 'posted date', 'trans date'],
  payee: ['name', 'payee', 'description', 'merchant', 'title', 'who'],
  envelope: ['envelope', 'category', 'envelope name', 'bucket'],
  amount: ['amount', 'value', 'debit/credit'],
  account: ['account', 'account name'],
  notes: ['notes', 'note', 'memo'],
  status: ['status', 'cleared'],
  details: ['details', 'split', 'splits'],
} as const;

export type FieldName = keyof typeof ALIASES;
export type ColumnMapping = Partial<Record<FieldName, string>>;

export function detectColumns(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<string>();

  for (const field of Object.keys(ALIASES) as FieldName[]) {
    for (const alias of ALIASES[field]) {
      const match = headers.find(
        (header) => !used.has(header) && header.trim().toLowerCase() === alias,
      );
      if (match) {
        mapping[field] = match;
        used.add(match);
        break;
      }
    }
  }
  return mapping;
}

export type DateFormat = 'iso' | 'dmy' | 'mdy' | 'ambiguous';

/**
 * Decide the file's date format from the whole column rather than row by row.
 *
 * A component above 12 can only be a day, so a single such row settles the
 * question for the file. If both positions exceed 12 somewhere the file is
 * inconsistent, which is reported rather than averaged over.
 */
export function detectDateFormat(values: string[]): { format: DateFormat; evidence: string } {
  let firstOver12 = 0;
  let secondOver12 = 0;
  let iso = 0;
  let slashed = 0;

  for (const value of values) {
    const text = value.trim();
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(text)) {
      iso += 1;
      continue;
    }
    const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(text);
    if (!match) continue;
    slashed += 1;
    if (Number(match[1]) > 12) firstOver12 += 1;
    if (Number(match[2]) > 12) secondOver12 += 1;
  }

  if (iso > 0 && slashed === 0) return { format: 'iso', evidence: `${iso} ISO-formatted rows` };
  if (firstOver12 > 0 && secondOver12 > 0) {
    return {
      format: 'ambiguous',
      evidence: `inconsistent: ${firstOver12} row(s) need D/M/Y and ${secondOver12} need M/D/Y`,
    };
  }
  if (firstOver12 > 0) {
    return { format: 'dmy', evidence: `${firstOver12} row(s) have a first component above 12` };
  }
  if (secondOver12 > 0) {
    return { format: 'mdy', evidence: `${secondOver12} row(s) have a second component above 12` };
  }
  return { format: 'ambiguous', evidence: 'every row could be read either way' };
}

export function parseExportDate(raw: string, format: DateFormat): string | undefined {
  const text = raw.trim();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]!.padStart(2, '0')}-${iso[3]!.padStart(2, '0')}`;

  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(text);
  if (!match) return undefined;

  const first = Number(match[1]);
  const second = Number(match[2]);
  const year = match[3]!.length === 2 ? `20${match[3]}` : match[3]!;

  // A component above 12 settles the row regardless of the file-level format.
  let day: number;
  let month: number;
  if (first > 12) {
    day = first;
    month = second;
  } else if (second > 12) {
    month = first;
    day = second;
  } else if (format === 'dmy') {
    day = first;
    month = second;
  } else {
    month = first;
    day = second;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** One `Envelope|Amount` pair from the Details column. */
export type SplitPart = { envelope: string; amountCents: number };

/** `Living:Groceries|-12.00||Health:Equipment|-24.40` -> two parts. */
export function parseDetails(details: string): SplitPart[] {
  const text = details.trim();
  if (text === '') return [];

  const parts: SplitPart[] = [];
  for (const chunk of text.split('||')) {
    const separator = chunk.lastIndexOf('|');
    if (separator < 0) continue;
    const envelope = chunk.slice(0, separator).trim();
    const rawAmount = chunk.slice(separator + 1).trim();
    if (envelope === '' || rawAmount === '') continue;
    try {
      parts.push({ envelope, amountCents: parseAmount(rawAmount).cents });
    } catch {
      // Reported by the caller as an unreadable split rather than dropped silently.
      return [];
    }
  }
  return parts;
}

export type RowKind =
  /** A normal categorized transaction. */
  | 'spending'
  /** A parent row split across several envelopes. */
  | 'split'
  /** Money into the unallocated pool. */
  | 'income'
  /** Between the user's own accounts; no envelope, never spending (FR-5). */
  | 'transfer'
  /**
   * Money moved between envelopes (FR-34). Exported as a matched +/- pair with
   * no account. Not spending, and poisonous as categorization training data:
   * in the sample export these 284 rows spanned 42 envelopes with no payee
   * signal at all.
   */
  | 'envelopeTransfer'
  /** A monthly "Fill Envelopes" marker. Carries no allocation data in the export. */
  | 'fill';

/** GoodBudget's fixed payee name for an envelope-to-envelope move. */
const ENVELOPE_TRANSFER_PAYEE = 'envelope transfer';

export type LoadResult = {
  mapping: ColumnMapping;
  dateFormat: DateFormat;
  dateEvidence: string;
  /** Envelope-bearing lines, with splits expanded into one line per envelope. */
  transactions: LabeledTransaction[];
  counts: Record<RowKind, number>;
  /** Rows expanded from split parents. */
  splitLines: number;
  skipped: { row: number; reason: string }[];
  warnings: string[];
};

export function loadGoodBudgetExport(source: string): LoadResult {
  const table = parseCsv(source, detectDelimiter(source));
  const mapping = detectColumns(table.headers);
  const records = toRecords(table);

  const skipped: LoadResult['skipped'] = [];
  const warnings: string[] = [];
  const transactions: LabeledTransaction[] = [];
  const counts: Record<RowKind, number> = {
    spending: 0, split: 0, income: 0, transfer: 0, envelopeTransfer: 0, fill: 0,
  };
  let splitLines = 0;

  const missing = (['date', 'payee', 'amount'] as FieldName[]).filter((field) => !mapping[field]);
  if (missing.length > 0) {
    warnings.push(
      `Could not find a column for: ${missing.join(', ')}. Headers seen: ${table.headers.join(', ') || '(none)'}`,
    );
    return {
      mapping, dateFormat: 'ambiguous', dateEvidence: 'not determined',
      transactions, counts, splitLines, skipped, warnings,
    };
  }

  const { format: dateFormat, evidence: dateEvidence } = detectDateFormat(
    records.map((record) => record[mapping.date!] ?? ''),
  );
  if (dateFormat === 'ambiguous') {
    warnings.push(
      `Date format could not be determined (${dateEvidence}). Reading as M/D/Y; confirm before committing a migration.`,
    );
  }

  records.forEach((record, index) => {
    const rowNumber = index + 2; // 1-based, plus the header row
    const date = parseExportDate(record[mapping.date!] ?? '', dateFormat);
    if (!date) {
      skipped.push({ row: rowNumber, reason: `Unreadable date "${record[mapping.date!]}"` });
      return;
    }

    const payeeRaw = (record[mapping.payee!] ?? '').trim();
    const envelope = (mapping.envelope ? record[mapping.envelope] : '')?.trim() ?? '';
    const details = (mapping.details ? record[mapping.details] : '')?.trim() ?? '';
    const account = mapping.account ? record[mapping.account] : undefined;
    const memo = mapping.notes ? record[mapping.notes]?.trim() : undefined;

    const rawAmount = record[mapping.amount!] ?? '';
    let amountCents = 0;
    if (rawAmount.trim() !== '') {
      try {
        const parsed = parseAmount(rawAmount);
        amountCents = parsed.cents;
        if (parsed.warning) warnings.push(`Row ${rowNumber}: ${parsed.warning}`);
      } catch (error) {
        skipped.push({ row: rowNumber, reason: (error as Error).message });
        return;
      }
    }

    const base = {
      date,
      payeeRaw,
      ...(account ? { account } : {}),
      ...(memo ? { memo } : {}),
    };

    // A monthly fill marker. GoodBudget exports these with no amount and no
    // per-envelope breakdown, so historical allocations are not recoverable.
    if (payeeRaw === 'Fill Envelopes') {
      counts.fill += 1;
      return;
    }

    // An envelope-to-envelope move. It carries an envelope, so it would
    // otherwise be mistaken for spending.
    if (payeeRaw.toLowerCase() === ENVELOPE_TRANSFER_PAYEE) {
      counts.envelopeTransfer += 1;
      return;
    }

    if (envelope !== '') {
      counts.spending += 1;
      transactions.push({ ...base, amountCents, envelope });
      return;
    }

    const parts = parseDetails(details);
    if (parts.length > 0) {
      const onlyAvailable = parts.every((part) => part.envelope === AVAILABLE);
      counts[onlyAvailable ? 'income' : 'split'] += 1;

      const sum = parts.reduce((total, part) => total + part.amountCents, 0);
      if (sum !== amountCents) {
        warnings.push(
          `Row ${rowNumber}: split parts sum to ${sum} but the row total is ${amountCents}`,
        );
      }

      for (const part of parts) {
        splitLines += 1;
        transactions.push({ ...base, amountCents: part.amountCents, envelope: part.envelope });
      }
      return;
    }

    if (details !== '') {
      warnings.push(`Row ${rowNumber}: unreadable Details "${details.slice(0, 40)}"`);
    }

    // No envelope and no split detail: a transfer between the user's own accounts.
    counts.transfer += 1;
  });

  return { mapping, dateFormat, dateEvidence, transactions, counts, splitLines, skipped, warnings };
}

export function describeMapping(mapping: ColumnMapping): string {
  return (Object.keys(ALIASES) as FieldName[])
    .map((field) => `  ${field.padEnd(9)} -> ${mapping[field] ?? '(not found)'}`)
    .join('\n');
}
