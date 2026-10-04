/**
 * Spike: drive Plaid's sandbox through the sync code in src/sync/ (#10).
 *
 *   npm run plaid -- link          make a sandbox Item and fetch its history
 *   npm run plaid -- sync          fetch what changed since the last sync
 *   npm run plaid -- refresh       have the sandbox move time on, then sync
 *   npm run plaid -- add           add a custom posted transaction, then sync
 *   npm run plaid -- reset-login   put the Item into ITEM_LOGIN_REQUIRED
 *   npm run plaid -- remove        revoke the Item (FR-20) and forget it
 *
 * Needs PLAID_CLIENT_ID and PLAID_SECRET in .env, and refuses to run unless
 * PLAID_ENV is sandbox: this is for fake banks only.
 *
 * Answers: do real responses read cleanly (cents, dates, descriptions), and
 * does a pending charge turn into its posting rather than sitting beside it?
 * The second is checked against a local copy that each sync is applied to, the
 * way the ledger will be. The sandbox user is `user_transactions_dynamic`,
 * whose pending charges post on each /transactions/refresh.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { localToday } from '../src/budget/month.ts';
import { formatCents } from '../src/money.ts';
import { planChanges, type PlaidTransaction } from '../src/sync/plaid.ts';
import { PlaidApiError, plaidCall, plaidConfigFromEnv, syncTransactions } from '../src/sync/plaidClient.ts';

const STATE_FILE = 'data/private/plaid-sandbox.json';
const INSTITUTION = 'ins_109508'; // First Platypus Bank, a sandbox institution

type State = {
  accessToken: string;
  cursor?: string;
  /** The local copy each sync is applied to, by Plaid transaction id. */
  transactions: Record<string, PlaidTransaction>;
};

const config = plaidConfigFromEnv();
if (config.environment !== 'sandbox') {
  console.error('This spike only runs against the sandbox. Set PLAID_ENV=sandbox.');
  process.exit(1);
}
const call = plaidCall(config);

function load(): State {
  if (!existsSync(STATE_FILE)) {
    console.error('No sandbox Item yet. Run: npm run plaid -- link');
    process.exit(1);
  }
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;
}

function save(state: State): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function line(t: PlaidTransaction): string {
  const flags = [t.pending ? 'pending' : '', t.currency && t.currency !== 'CAD' ? t.currency : '']
    .filter(Boolean)
    .join(', ');
  return `${t.date}  ${formatCents(t.amountCents).padStart(10)}  ${t.description}${flags ? `  (${flags})` : ''}`;
}

async function sync(state: State): Promise<void> {
  const result = await syncTransactions(call, state.accessToken, state.cursor);
  const plan = planChanges(result);
  const local = state.transactions;
  const counts = { add: 0, post: 0, postedWithoutPending: 0, update: 0, remove: 0, removeIgnored: 0 };

  for (const change of plan) {
    switch (change.kind) {
      case 'add':
        local[change.transaction.id] = change.transaction;
        counts.add++;
        break;
      case 'post': {
        const before = local[change.pendingId];
        if (before) {
          delete local[change.pendingId];
          counts.post++;
          console.log(`  posted:   ${line(before)}`);
          console.log(`        ->  ${line(change.transaction)}`);
        } else {
          counts.postedWithoutPending++;
        }
        local[change.transaction.id] = change.transaction;
        break;
      }
      case 'update':
        local[change.transaction.id] = change.transaction;
        counts.update++;
        break;
      case 'remove':
        if (local[change.id]) {
          console.log(`  removed:  ${line(local[change.id]!)}`);
          delete local[change.id];
          counts.remove++;
        } else {
          counts.removeIgnored++;
        }
        break;
    }
  }

  // The FR-19 check: nothing posted may still have its pending charge beside it.
  const all = Object.values(local);
  const doubled = all.filter((t) => t.pendingId && local[t.pendingId]);
  state.cursor = result.cursor;
  save(state);

  console.log(
    `\n${plan.length} changes (status ${result.status ?? 'unknown'}):`,
    `${counts.add} added, ${counts.post} posted over their pending charge,`,
    `${counts.postedWithoutPending} posted with no pending charge seen,`,
    `${counts.update} updated, ${counts.remove} removed, ${counts.removeIgnored} removals of unknown ids.`,
  );
  console.log(`Local copy: ${all.length} transactions, ${all.filter((t) => t.pending).length} pending.`);
  const warned = all.filter((t) => t.warnings.length > 0);
  if (warned.length > 0) {
    console.log(`${warned.length} carry a warning, for example: ${warned[0]!.warnings[0]}`);
  }
  if (doubled.length > 0) {
    console.log(`\nFR-19 FAILED: ${doubled.length} posted transactions still sit beside their pending charge.`);
    process.exitCode = 1;
  }

  console.log('\nAccounts:');
  for (const account of result.accounts) {
    const balance = account.currentCents === undefined ? 'no balance' : formatCents(account.currentCents);
    console.log(`  ${account.name} (${account.subtype ?? account.type}, ...${account.mask ?? '?'})  ${balance} ${account.currency ?? ''}`);
  }

  const recent = all.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  console.log('\nMost recent:');
  for (const t of recent) console.log(`  ${line(t)}`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'sync';

  switch (command) {
    case 'link': {
      if (existsSync(STATE_FILE)) {
        console.error(`${STATE_FILE} already holds an Item. Run "remove" first to start again.`);
        process.exit(1);
      }
      const created = JSON.parse(
        await call('/sandbox/public_token/create', {
          institution_id: INSTITUTION,
          initial_products: ['transactions'],
          options: {
            override_username: 'user_transactions_dynamic',
            override_password: 'any',
            transactions: { days_requested: 90 },
          },
        }),
      ) as { public_token: string };
      const exchanged = JSON.parse(
        await call('/item/public_token/exchange', { public_token: created.public_token }),
      ) as { access_token: string };
      const state: State = { accessToken: exchanged.access_token, transactions: {} };
      save(state);
      console.log('Linked a sandbox Item. Plaid takes a few seconds to gather its history.');
      // Syncing straight away usually returns nothing yet; say so instead of
      // leaving an empty result to be read as a failure.
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await sync(state);
      console.log('\nIf that was empty, wait a few seconds and run: npm run plaid -- sync');
      break;
    }
    case 'sync':
      await sync(load());
      break;
    case 'refresh': {
      const state = load();
      await call('/transactions/refresh', { access_token: state.accessToken });
      console.log('Asked the sandbox for new activity; waiting for it to arrive.');
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await sync(state);
      break;
    }
    case 'add': {
      const state = load();
      const today = localToday();
      await call('/sandbox/transactions/create', {
        access_token: state.accessToken,
        transactions: [
          { date_transacted: today, date_posted: today, amount: 12.34, description: 'SPIKE TEST PURCHASE' },
        ],
      });
      console.log('Added a $12.34 purchase; waiting for it to arrive.');
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await sync(state);
      break;
    }
    case 'reset-login': {
      const state = load();
      await call('/sandbox/item/reset_login', { access_token: state.accessToken });
      console.log('The Item now needs its login again. A sync should fail with ITEM_LOGIN_REQUIRED:');
      await sync(state);
      break;
    }
    case 'remove': {
      const state = load();
      await call('/item/remove', { access_token: state.accessToken });
      rmSync(STATE_FILE);
      console.log('Revoked the Item at Plaid and forgot its token.');
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  if (error instanceof PlaidApiError) {
    console.error(`Plaid refused: ${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
