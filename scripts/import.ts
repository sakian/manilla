/**
 * Import an OFX/QFX file from the command line.
 *
 *   npm run import -- data/private/accountactivity.ofx
 *   npm run import -- data/private/accountactivity.ofx --dry-run
 *
 * Prints the preview FR-9 calls for, then commits unless --dry-run. Rows that
 * merely look like duplicates are listed and skipped by default; they are never
 * dropped silently, and never merged without being asked for.
 */

import { readFileSync } from 'node:fs';
import { createDb } from '../db/client.ts';
import { parseOfx } from '../src/ofx/parse.ts';
import { commitImport, previewImport, resolveAccount } from '../src/import/ofxImport.ts';
import { formatCents } from '../src/money.ts';

const args = process.argv.slice(2);
const path = args.find((arg) => !arg.startsWith('--'));
const dryRun = args.includes('--dry-run');
const useAi = args.includes('--ai');

if (!path) {
  console.error('Usage: npm run import -- <file.ofx> [--dry-run] [--ai]');
  process.exit(1);
}

const db = createDb();
const doc = parseOfx(readFileSync(path, 'utf8'));

for (const warning of doc.warnings) console.log(`! ${warning}`);

for (const statement of doc.statements) {
  const account = await resolveAccount(db, statement);
  if (!account) {
    console.error(
      `\nNo account is mapped to bank account ${statement.accountId}.\n` +
        'Create one with that external id first (see scripts/seed.ts).',
    );
    continue;
  }

  console.log(`\n=== ${account.name} (${statement.accountId}) ===`);
  const preview = await previewImport(db, statement, account.id, { useAi });

  console.log(`  new:                ${preview.counts.new}`);
  console.log(`  already imported:   ${preview.counts.duplicate}`);
  console.log(`  possible duplicate: ${preview.counts.possible_duplicate}`);

  if (preview.balanceCheck) {
    const { statedCents, projectedCents, matches } = preview.balanceCheck;
    console.log(
      `  statement balance:  ${formatCents(statedCents)} vs ${formatCents(projectedCents)} here` +
        (matches ? '  (matches)' : '  (MISMATCH - some history is missing)'),
    );
  }

  const suggested = preview.rows.filter((row) => row.suggestion?.envelope).length;
  if (preview.counts.new > 0) {
    console.log(`  suggested envelope: ${suggested}/${preview.counts.new}`);
  }

  for (const row of preview.rows.filter((r) => r.verdict === 'possible_duplicate')) {
    console.log(
      `  ? ${row.transaction.posted} ${formatCents(row.transaction.amountCents)} ${row.transaction.name}`,
    );
    console.log(`      ${row.reason}`);
  }

  if (dryRun) {
    console.log('\n  --dry-run: nothing written.');
    continue;
  }

  const result = await commitImport(db, preview, new Map(), { filename: path });
  console.log(`\n  imported ${result.added}, skipped ${result.skipped}, linked ${result.linked}`);
  console.log(`  batch ${result.batchId}`);
}

await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
