/**
 * Development seed: a starting chart of envelopes and one account.
 *
 * Envelope names and groups are an ordinary household's chart, at the size a real one
 * reaches, so the categorizer is exercised
 * against something shaped like the real thing rather than a toy.
 *
 *   npm run seed                 create envelopes and an account
 *   npm run seed -- --reset      wipe everything first
 */

import { sql } from 'drizzle-orm';
import { createDb } from '../db/client.ts';
import { envelopeGroups, envelopes } from '../db/schema.ts';
import { openAccount } from '../src/ledger/ledger.ts';

const GROUPS: Record<string, string[]> = {
  Income: ['Available'],
  Living: ['Groceries and Supplies', 'Eating Out', 'Household Misc', 'Gifts', 'Clothing and Shoes', 'Banking Fees'],
  Vehicle: ['Gas', 'Insurance', 'Repairs'],
  Home: ['Mortgage', 'Upkeep and Upgrades', 'Insurance'],
  Utilities: ['Electricity', 'Phone', 'Internet', 'Water', 'Natural Gas'],
  Health: ['Pharmacy', 'Life Insurance', 'Misc Spending'],
  Saving: ['Emergency Fund', 'Vacation'],
  Work: ['Work Expenses'],
};

const db = createDb();
const reset = process.argv.includes('--reset');

if (reset) {
  await db.execute(sql`
    truncate table
      txn_lines, suggestions, transaction_external_ids, transactions,
      envelope_moves, budget_lines, rules, import_batches,
      envelopes, envelope_groups, accounts
    restart identity cascade
  `);
  console.log('cleared existing data');
}

const existing = await db.select({ id: envelopes.id }).from(envelopes).limit(1);
if (existing.length > 0) {
  console.log('Envelopes already exist. Pass --reset to start over.');
  process.exit(0);
}

let groupPosition = 0;
for (const [groupName, names] of Object.entries(GROUPS)) {
  const [group] = await db
    .insert(envelopeGroups)
    .values({ name: groupName, position: groupPosition++ })
    .returning({ id: envelopeGroups.id });

  await db.insert(envelopes).values(
    names.map((name, index) => ({
      groupId: group!.id,
      name,
      position: index,
      // The one income pool, which a migrated export's own pool maps onto.
      isUnallocated: groupName === 'Income' && name === 'Available',
    })),
  );
}

const envelopeCount = await db.select({ id: envelopes.id }).from(envelopes);
console.log(`created ${Object.keys(GROUPS).length} groups, ${envelopeCount.length} envelopes`);

// The external id is the account number as the bank's export states it, which
// is how an imported statement finds its account (FR-7). It is a real financial
// identifier, so it comes from the environment rather than living in the repo:
// set SEED_ACCOUNT_EXTERNAL_ID in .env to the ACCTID in your own export.
const accountId = await openAccount(db, {
  name: process.env.SEED_ACCOUNT_NAME ?? 'Main Chequing',
  kind: 'chequing',
  externalAccountId: process.env.SEED_ACCOUNT_EXTERNAL_ID ?? '000000000',
  openingBalanceCents: 0,
});

if (!process.env.SEED_ACCOUNT_EXTERNAL_ID) {
  console.log(
    'note: SEED_ACCOUNT_EXTERNAL_ID is unset, so the account uses a placeholder\n' +
      '      number and no statement will map to it. Set it in .env to import.',
  );
}
console.log(`created account Main Chequing (${accountId})`);

await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
