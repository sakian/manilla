/**
 * The daily sync (FR-16).
 *
 * An hourly check rather than a fixed time, so a server that was down at the
 * hour still syncs when it comes back, and each connection goes about a day
 * after its last attempt. An attempt that failed counts, so a bank that is
 * down is tried again tomorrow, not every hour.
 */

import { and, eq, isNotNull, isNull, lt, ne, or } from 'drizzle-orm';
import { connectionFor, homeDb, type Database } from '../../db/client.ts';
import { bankConnections } from '../../db/schema.ts';
import { databaseOf } from '../ledgers/config.ts';
import { listLedgers } from '../ledgers/registry.ts';
import { plaidCall, plaidConfigFromEnv, type PlaidCall } from './plaidClient.ts';
import { syncConnection, type SyncReport } from './run.ts';
import { secretKeyFromEnv } from './secret.ts';
import { runAs } from '../audit/actor.ts';
import { pendingCount } from '../queue/queue.ts';
import { newlyOverdrawn, sendSyncNotice, syncNotice, type LedgerAfterSync, type SyncOutcome } from './notice.ts';
import { listEnvelopes } from '../envelopes/manage.ts';

/** Under a day, so a sync that ran at 6:05 is due again by 6:00 tomorrow. */
const DUE_AFTER_MS = 20 * 60 * 60 * 1000;

const CHECK_EVERY_MS = 60 * 60 * 1000;

/**
 * Connections due a sync. Not one waiting for its login: only a person can
 * sign in again, and until then every attempt fails the same way.
 */
export async function connectionsDue(db: Database, now: Date): Promise<string[]> {
  const rows = await db
    .select({ id: bankConnections.id })
    .from(bankConnections)
    .where(
      and(
        isNull(bankConnections.revokedAt),
        isNotNull(bankConnections.accessToken),
        or(isNull(bankConnections.errorCode), ne(bankConnections.errorCode, 'ITEM_LOGIN_REQUIRED')),
        or(
          isNull(bankConnections.lastAttemptAt),
          lt(bankConnections.lastAttemptAt, new Date(now.getTime() - DUE_AFTER_MS)),
        ),
      ),
    );
  return rows.map((row) => row.id);
}

export async function syncDue(
  db: Database,
  deps: { call: PlaidCall; key: Buffer; account?: Database },
  now: Date = new Date(),
): Promise<SyncReport[]> {
  const reports: SyncReport[] = [];
  for (const id of await connectionsDue(db, now)) {
    reports.push(await syncConnection(db, id, { ...deps, now: () => now }));
  }
  return reports;
}

const STARTED = Symbol.for('manilla.dailySync');

/**
 * Start the hourly check, across every ledger. Does nothing without Plaid keys
 * and a secret key: a Manilla that imports files only never needs either.
 */
export function startDailySync(log: (line: string) => void): void {
  const holder = globalThis as { [STARTED]?: boolean };
  if (holder[STARTED]) return;

  let deps: { call: PlaidCall; key: Buffer };
  try {
    deps = { call: plaidCall(plaidConfigFromEnv()), key: secretKeyFromEnv() };
  } catch {
    log('bank feeds are off: PLAID_CLIENT_ID, PLAID_SECRET and MANILLA_SECRET_KEY are not all set');
    return;
  }
  holder[STARTED] = true;

  // Nobody is signed in at 3am; the audit trail says what did it instead.
  const check = () => runAs({ id: null, name: 'Daily bank sync' }, checkAll);
  const checkAll = async () => {
    const notifyUrl = process.env.MANILLA_SYNC_NOTIFY_URL;
    const outcomes: SyncOutcome[] = [];
    const after = new Map<string, LedgerAfterSync>();
    let ledgerCount = 0;
    try {
      const home = homeDb();
      const ledgers = await listLedgers(home, databaseOf(process.env.DATABASE_URL ?? ''));
      ledgerCount = ledgers.length;
      for (const ledger of ledgers) {
        const db = connectionFor(ledger.database);
        // A look before the sync, so afterwards it can say which envelopes the
        // sync itself took below zero rather than every one that is.
        const before = notifyUrl ? await listEnvelopes(db) : [];
        const reports = await syncDue(db, { ...deps, account: home });
        for (const report of reports) {
          const added = report.accounts.reduce((sum, account) => sum + account.added, 0);
          const held = report.accounts.reduce((sum, account) => sum + account.held, 0);
          if (notifyUrl) {
            outcomes.push({
              ledger: ledger.name,
              bank: await bankName(db, report.connectionId),
              added,
              held,
              ...(report.error ? { error: report.error.code } : {}),
            });
          }
          const notReady = report.accounts.filter((account) => account.notReady).length;
          log(
            report.error
              ? `bank sync in ${ledger.name} stopped: ${report.error.code}`
              : `bank sync in ${ledger.name}: ${added} added, ${held} held for you` +
                  (notReady > 0 ? `, ${notReady} accounts not ready at Plaid yet` : ''),
          );
        }
        if (notifyUrl && reports.length > 0) {
          after.set(ledger.name, {
            waiting: await pendingCount(db),
            overdrawn: newlyOverdrawn(before, await listEnvelopes(db)),
          });
        }
      }
    } catch (error) {
      // One bad hour is logged and the next one tries again; it must not take
      // the server down with it.
      log(`bank sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Whatever was synced before a failure is still worth saying.
    const notice = notifyUrl ? syncNotice(outcomes, after, { manyLedgers: ledgerCount > 1 }) : null;
    if (notice) await sendSyncNotice(notifyUrl!, notice, process.env.MANILLA_ORIGIN);
  };

  setTimeout(check, 60_000).unref();
  setInterval(check, CHECK_EVERY_MS).unref();
  log('bank feeds sync daily');
}

/** What a person calls the bank: Plaid's institution name, when it gave one. */
async function bankName(db: Database, connectionId: string): Promise<string> {
  const [row] = await db
    .select({ name: bankConnections.institutionName })
    .from(bankConnections)
    .where(eq(bankConnections.id, connectionId));
  return row?.name ?? 'Your bank';
}
