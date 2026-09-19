/**
 * Phase 0 spike: report on a real OFX/QFX file from the bank.
 *
 *   npm run ofx -- data/private/statement.qfx
 *   npm run ofx                                  (scans data/private/)
 *
 * Answers the Phase 0 questions: does the bank's export parse, does every
 * transaction carry a stable id for deduplication, and is the description
 * rich enough for categorization to work from?
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { parseOfx } from '../src/ofx/parse.ts';
import { formatCents } from '../src/money.ts';
import { normalizePayee } from '../src/categorize/normalize.ts';

const PRIVATE_DIR = 'data/private';

function filesToInspect(): string[] {
  const fromArgs = process.argv.slice(2);
  if (fromArgs.length > 0) return fromArgs;

  if (!existsSync(PRIVATE_DIR)) return [];
  return readdirSync(PRIVATE_DIR)
    .filter((name) => ['.ofx', '.qfx'].includes(extname(name).toLowerCase()))
    .map((name) => join(PRIVATE_DIR, name));
}

function report(path: string): void {
  console.log(`\n=== ${path} ===`);

  let doc;
  try {
    doc = parseOfx(readFileSync(path, 'utf8'));
  } catch (error) {
    console.log(`  FAILED TO PARSE: ${(error as Error).message}`);
    console.log('  Send this file (or a redacted copy) to the parser tests as a new fixture.');
    return;
  }

  console.log(`  OFX version:  ${doc.version}  ${doc.intuitBankId ? `(QFX, INTU.BID ${doc.intuitBankId})` : ''}`);
  if (doc.warnings.length > 0) {
    console.log('  Warnings:');
    for (const warning of doc.warnings) console.log(`    - ${warning}`);
  }

  for (const statement of doc.statements) {
    const transactions = statement.transactions;
    console.log(`\n  Account ${statement.accountId} (${statement.kind}, ${statement.currency ?? 'currency not stated'})`);
    console.log(`    Period:       ${statement.start ?? '?'} to ${statement.end ?? '?'}`);
    console.log(`    Transactions: ${transactions.length}`);

    if (statement.ledgerBalanceCents !== undefined) {
      console.log(`    Ledger balance: ${formatCents(statement.ledgerBalanceCents)} as of ${statement.ledgerBalanceAsOf ?? '?'}`);
    } else {
      console.log('    Ledger balance: NOT PROVIDED (FR-14 balance check unavailable for this bank)');
    }

    if (transactions.length === 0) continue;

    // FR-10: deduplication depends on a stable, unique id per account.
    const ids = transactions.map((t) => t.fitId).filter(Boolean);
    const unique = new Set(ids);
    console.log(`    FITIDs:       ${ids.length}/${transactions.length} present, ${unique.size} unique`);
    if (ids.length < transactions.length) {
      console.log('      -> Some transactions have no FITID; CSV-style fallback dedupe needed.');
    }
    if (unique.size < ids.length) {
      console.log('      -> DUPLICATE FITIDs within one account. Dedupe must also compare date+amount.');
    }

    // CA-1: how well do descriptions collapse into merchants?
    const keys = transactions.map((t) => normalizePayee(t.name || t.memo || '').key);
    const distinct = new Set(keys);
    console.log(`    Merchants:    ${distinct.size} distinct after normalization (from ${transactions.length} rows)`);

    const memos = transactions.filter((t) => t.memo).length;
    console.log(`    Memo present: ${memos}/${transactions.length}`);

    console.log('\n    Sample rows (raw description -> normalized):');
    for (const transaction of transactions.slice(0, 8)) {
      const { key } = normalizePayee(transaction.name || transaction.memo || '');
      console.log(
        `      ${transaction.posted}  ${formatCents(transaction.amountCents).padStart(11)}  ${(transaction.name || '(no name)').slice(0, 38).padEnd(38)} -> ${key}`,
      );
    }

    const flagged = transactions.filter((t) => t.warnings.length > 0);
    if (flagged.length > 0) {
      console.log(`\n    ${flagged.length} row(s) with warnings, first few:`);
      for (const transaction of flagged.slice(0, 5)) {
        console.log(`      ${transaction.posted} ${transaction.warnings.join('; ')}`);
      }
    }
  }
}

const files = filesToInspect();
if (files.length === 0) {
  console.log(`No OFX/QFX files found.

Export a statement from your bank (look for "Download" / "Export" and pick
OFX, QFX, or "Quicken"), then drop it in:

    ${PRIVATE_DIR}/

That folder is gitignored, so nothing lands in version control. Then re-run:

    npm run ofx
`);
} else {
  for (const file of files) report(file);
  console.log('');
}
