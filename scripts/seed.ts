/**
 * Development seed: a starting chart of envelopes and one account.
 *
 * An ordinary household's chart, at the size a real one reaches - eight groups
 * and two dozen envelopes - because the categorizer behaves differently against
 * twenty-five envelopes than against three, and a toy chart hides that. Rename
 * or replace all of it; nothing else depends on these names.
 *
 *   npm run seed                 create envelopes and an account
 *   npm run seed -- --reset      wipe everything first
 */

import { eq, sql } from 'drizzle-orm';
import { createDb } from '../db/client.ts';
import { envelopeGroups, envelopes } from '../db/schema.ts';
import { ensureIncomePool, openAccount } from '../src/ledger/ledger.ts';

const GROUPS: Record<string, string[]> = {
  Living: [
    'Groceries and Supplies',
    'Eating Out',
    'Household Misc',
    'Gifts',
    'Clothing and Shoes',
    'Banking Fees',
  ],
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

// The income pool alone is what a fresh install already has, so it does not
// count as a chart someone has started.
const existing = await db
  .select({ id: envelopes.id })
  .from(envelopes)
  .where(eq(envelopes.isUnallocated, false))
  .limit(1);
if (existing.length > 0) {
  console.log('Envelopes already exist. Pass --reset to start over.');
  process.exit(0);
}

// The pool is made where the app makes it, in an Income group of its own, and
// the chart below goes after it.
await ensureIncomePool(db);

let groupPosition = 1;
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
    })),
  );
}

const envelopeCount = await db.select({ id: envelopes.id }).from(envelopes);
console.log(`created ${Object.keys(GROUPS).length} groups, ${envelopeCount.length} envelopes`);

// A placeholder account number, on purpose.
//
// The real one is how an imported statement finds its account (FR-7), but it
// does not have to be known up front: the first import matches nothing, so the
// import screen asks which account the statement belongs to and writes the real
// ACCTID in when you answer. Everything after that maps itself. Asking for it
// here would mean a real financial identifier in a config file to save one
// dropdown, once.
const accountId = await openAccount(db, {
  name: process.env.SEED_ACCOUNT_NAME ?? 'Main Chequing',
  kind: 'chequing',
  externalAccountId: '000000000',
  openingBalanceCents: 0,
});

const accountName = process.env.SEED_ACCOUNT_NAME ?? 'Main Chequing';
console.log(`created account ${accountName} (${accountId})`);
console.log(
  'note: it has a placeholder account number, so your first import will ask\n' +
    '      which account the statement belongs to. It remembers the answer.',
);

await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
