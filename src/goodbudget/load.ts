/**
 * GoodBudget export loader (MG-1, MG-2).
 *
 * The exact column names in a GoodBudget CSV export are not yet confirmed
 * against a real file, so columns are detected by matching header names against
 * a list of aliases rather than hard-coded positions. `describeMapping` reports
 * what it matched, which is how the Phase 0 inspector shows whether the guess
 * was right before any data is trusted.
 */

import { parseCsv, detectDelimiter, toRecords } from '../csv.ts';
import { parseAmount } from '../money.ts';
import type { LabeledTransaction } from '../categorize/types.ts';

/** Candidate header names per field, lowercased, most specific first. */
const ALIASES = {
  date: ['date', 'transaction date', 'posted date', 'trans date'],
  payee: ['name', 'payee', 'description', 'merchant', 'title', 'who'],
  envelope: ['envelope', 'category', 'envelope name', 'bucket'],
  amount: ['amount', 'value', 'debit/credit'],
  account: ['account', 'account name'],
  notes: ['notes', 'note', 'memo', 'details', 'description2'],
  status: ['status', 'cleared'],
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

/**
 * Normalize the date formats an export might use into `YYYY-MM-DD`.
 * Ambiguous day/month ordering is reported rather than guessed.
 */
export function parseExportDate(raw: string): { date?: string; ambiguous?: boolean } {
  const text = raw.trim();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) {
    return { date: `${iso[1]}-${iso[2]!.padStart(2, '0')}-${iso[3]!.padStart(2, '0')}` };
  }

  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(text);
  if (slashed) {
    const first = Number(slashed[1]);
    const second = Number(slashed[2]);
    const year = slashed[3]!.length === 2 ? `20${slashed[3]}` : slashed[3]!;
    // North American exports are M/D/Y. If the first number cannot be a month,
    // it must be D/M/Y; if both are <= 12 the file is genuinely ambiguous.
    const monthFirst = first <= 12;
    const month = monthFirst ? first : second;
    const day = monthFirst ? second : first;
    return {
      date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      ambiguous: first <= 12 && second <= 12 && first !== second,
    };
  }

  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) return { date: new Date(parsed).toISOString().slice(0, 10) };

  return {};
}

export type LoadResult = {
  mapping: ColumnMapping;
  transactions: LabeledTransaction[];
  /** Rows that could not be read, with the reason. */
  skipped: { row: number; reason: string }[];
  /** Non-fatal observations worth showing before committing a migration. */
  warnings: string[];
  /** Rows whose date format could have been read two ways. */
  ambiguousDates: number;
};

export function loadGoodBudgetExport(source: string): LoadResult {
  const table = parseCsv(source, detectDelimiter(source));
  const mapping = detectColumns(table.headers);
  const records = toRecords(table);

  const skipped: LoadResult['skipped'] = [];
  const warnings: string[] = [];
  const transactions: LabeledTransaction[] = [];
  let ambiguousDates = 0;

  const missing = (['date', 'payee', 'amount'] as FieldName[]).filter((field) => !mapping[field]);
  if (missing.length > 0) {
    warnings.push(
      `Could not find a column for: ${missing.join(', ')}. Headers seen: ${table.headers.join(', ') || '(none)'}`,
    );
    return { mapping, transactions, skipped, warnings, ambiguousDates };
  }
  if (!mapping.envelope) {
    warnings.push('No envelope/category column found; transactions will load uncategorized');
  }

  records.forEach((record, index) => {
    const rowNumber = index + 2; // 1-based, plus the header row
    const { date, ambiguous } = parseExportDate(record[mapping.date!] ?? '');
    if (!date) {
      skipped.push({ row: rowNumber, reason: `Unreadable date "${record[mapping.date!]}"` });
      return;
    }
    if (ambiguous) ambiguousDates += 1;

    const rawAmount = record[mapping.amount!] ?? '';
    if (rawAmount.trim() === '') {
      skipped.push({ row: rowNumber, reason: 'Empty amount' });
      return;
    }

    let amountCents: number;
    try {
      const parsedAmount = parseAmount(rawAmount);
      amountCents = parsedAmount.cents;
      if (parsedAmount.warning) warnings.push(`Row ${rowNumber}: ${parsedAmount.warning}`);
    } catch (error) {
      skipped.push({ row: rowNumber, reason: (error as Error).message });
      return;
    }

    transactions.push({
      date,
      payeeRaw: record[mapping.payee!] ?? '',
      amountCents,
      envelope: (mapping.envelope ? record[mapping.envelope] : '')?.trim() || '(uncategorized)',
      ...(mapping.account ? { account: record[mapping.account] } : {}),
      ...(mapping.notes && record[mapping.notes] ? { memo: record[mapping.notes] } : {}),
    });
  });

  if (ambiguousDates > 0) {
    warnings.push(
      `${ambiguousDates} row(s) have a D/M/Y-or-M/D/Y date. Confirm the export's date format before committing.`,
    );
  }

  return { mapping, transactions, skipped, warnings, ambiguousDates };
}

export function describeMapping(mapping: ColumnMapping): string {
  const fields = Object.keys(ALIASES) as FieldName[];
  return fields
    .map((field) => `  ${field.padEnd(9)} -> ${mapping[field] ?? '(not found)'}`)
    .join('\n');
}
