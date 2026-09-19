/**
 * Phase 0 spike: profile a real GoodBudget export before designing the migration.
 *
 *   npm run goodbudget -- data/private/goodbudget-history.csv
 *   npm run goodbudget                                          (scans data/private/)
 *
 * Reports what the file actually contains: which columns exist, how far the
 * history goes, the envelope list, and which rows are transfers, income or
 * splits. That is what turns the MG-* requirements from assumptions into a
 * concrete mapping.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { parseCsv, detectDelimiter } from '../src/csv.ts';
import { loadGoodBudgetExport, describeMapping } from '../src/goodbudget/load.ts';
import { formatCents } from '../src/money.ts';
import { normalizePayee } from '../src/categorize/normalize.ts';

const PRIVATE_DIR = 'data/private';
const OUT_DIR = 'out';

function filesToInspect(): string[] {
  const fromArgs = process.argv.slice(2);
  if (fromArgs.length > 0) return fromArgs;
  if (!existsSync(PRIVATE_DIR)) return [];
  return readdirSync(PRIVATE_DIR)
    .filter((name) => ['.csv', '.tsv', '.txt'].includes(extname(name).toLowerCase()))
    .map((name) => join(PRIVATE_DIR, name));
}

function inspect(path: string): void {
  console.log(`\n=== ${path} ===`);
  const source = readFileSync(path, 'utf8');

  const delimiter = detectDelimiter(source);
  const raw = parseCsv(source, delimiter);
  console.log(`  Delimiter: ${delimiter === '\t' ? '(tab)' : delimiter}`);
  console.log(`  Columns (${raw.headers.length}): ${raw.headers.join(' | ')}`);
  console.log(`  Data rows: ${raw.rows.length}`);

  const result = loadGoodBudgetExport(source);
  console.log('\n  Column mapping:');
  console.log(describeMapping(result.mapping));

  for (const warning of result.warnings.slice(0, 10)) console.log(`  ! ${warning}`);
  if (result.warnings.length > 10) console.log(`  ! ...and ${result.warnings.length - 10} more warnings`);

  const transactions = result.transactions;
  if (transactions.length === 0) {
    console.log('\n  No transactions could be read. The column mapping above is the thing to fix.');
    console.log('  First data row, for reference:');
    console.log(`    ${JSON.stringify(raw.rows[0])}`);
    return;
  }

  const dates = transactions.map((t) => t.date).sort();
  const envelopes = new Map<string, { count: number; totalCents: number }>();
  for (const transaction of transactions) {
    const entry = envelopes.get(transaction.envelope) ?? { count: 0, totalCents: 0 };
    entry.count += 1;
    entry.totalCents += transaction.amountCents;
    envelopes.set(transaction.envelope, entry);
  }

  const income = transactions.filter((t) => t.amountCents > 0);
  const spend = transactions.filter((t) => t.amountCents < 0);
  const zero = transactions.filter((t) => t.amountCents === 0);
  const merchants = new Set(transactions.map((t) => normalizePayee(t.payeeRaw).key));

  console.log(`\n  Loaded ${transactions.length} transactions, ${result.skipped.length} skipped`);
  console.log(`  Date range:  ${dates[0]} to ${dates[dates.length - 1]}`);
  console.log(`  Money in:    ${income.length} rows`);
  console.log(`  Money out:   ${spend.length} rows`);
  if (zero.length > 0) console.log(`  Zero amount: ${zero.length} rows (likely splits or transfers - MG-4)`);
  console.log(`  Envelopes:   ${envelopes.size}`);
  console.log(`  Merchants:   ${merchants.size} distinct after normalization`);

  // Per-merchant repetition is the single best predictor of how well the
  // history layer will do, so measure it before building anything.
  const perMerchant = new Map<string, number>();
  for (const transaction of transactions) {
    const key = normalizePayee(transaction.payeeRaw).key;
    perMerchant.set(key, (perMerchant.get(key) ?? 0) + 1);
  }
  const repeated = [...perMerchant.values()].filter((count) => count >= 3).length;
  const coveredByRepeats = transactions.filter(
    (t) => (perMerchant.get(normalizePayee(t.payeeRaw).key) ?? 0) >= 3,
  ).length;
  console.log(
    `  Repeat merchants (3+ visits): ${repeated}, covering ${coveredByRepeats} of ${transactions.length} transactions ` +
      `(${((coveredByRepeats / transactions.length) * 100).toFixed(1)}%)`,
  );
  console.log('    -> This is roughly the ceiling for the history layer alone (CA-3).');

  console.log('\n  Envelopes by transaction count:');
  const ranked = [...envelopes.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [name, stats] of ranked.slice(0, 25)) {
    console.log(`    ${String(stats.count).padStart(6)}  ${formatCents(stats.totalCents).padStart(13)}  ${name}`);
  }
  if (ranked.length > 25) console.log(`    ...and ${ranked.length - 25} more`);

  if (result.skipped.length > 0) {
    console.log(`\n  Skipped rows (first 10 of ${result.skipped.length}):`);
    for (const item of result.skipped.slice(0, 10)) console.log(`    row ${item.row}: ${item.reason}`);
  }

  // Cache the parsed history so the eval harness does not re-parse it.
  mkdirSync(OUT_DIR, { recursive: true });
  const cachePath = join(OUT_DIR, 'history.json');
  writeFileSync(cachePath, JSON.stringify(transactions, null, 2));
  console.log(`\n  Parsed history written to ${cachePath} (gitignored) for the categorizer eval.`);
}

const files = filesToInspect();
if (files.length === 0) {
  console.log(`No CSV files found.

In GoodBudget, export your transaction history (web app: Settings or Account ->
Export, which produces a CSV), then drop the file in:

    ${PRIVATE_DIR}/

That folder is gitignored. Then re-run:

    npm run goodbudget
`);
} else {
  for (const file of files) inspect(file);
  console.log('');
}
