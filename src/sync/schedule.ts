/**
 * The daily sync (FR-16).
 *
 * An hourly check rather than a fixed time, so a server that was down at the
 * hour still syncs when it comes back, and each connection goes about a day
 * after its last attempt. An attempt that failed counts, so a bank that is
 * down is tried again tomorrow, not every hour.
 *
 * With Plaid's webhooks on (webhook.ts), most syncs happen when Plaid says it
 * has something, and each of those counts as an attempt too - so this only
 * runs for a bank Plaid has been quiet about for most of a day, which is what
 * catches a webhook that never arrived.
 */

import { and, eq, isNotNull, isNull, lt, ne, or } from 'drizzle-orm';
import { connectionFor, homeDb, type Database } from '../../db/client.ts';
import { bankConnections } from '../../db/schema.ts';
import { databaseOf } from '../ledgers/config.ts';
import { listLedgers } from '../ledgers/registry.ts';
import { plaidCall, plaidConfigFromEnv, type PlaidCall } from './plaidClient.ts';
import { syncConnection, type SyncReport } from './run.ts';
import { oneAtATime } from './serial.ts';
import { registerWebhooks, webhookUrlFromEnv } from './webhook.ts';
import { secretKeyFromEnv } from './secret.ts';
import { runAs } from '../audit/actor.ts';
import { pendingCount } from '../queue/queue.ts';
import {
  TITLES,
  incomeArrived,
  newlyOverdrawn,
  newlyUnusual,
  sendSyncNotice,
  syncNotices,
  type LedgerAfterSync,
  type SyncOutcome,
} from './notice.ts';
import { unusualCharges } from '../insights/insights.ts';
import { listEnvelopes } from '../envelopes/manage.ts';
import { anyoneListening, notifyMembers } from '../push/push.ts';

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

const STARTED = Symbol.for('manilla.dailySync');

type Deps = { call: PlaidCall; key: Buffer };

/**
 * Start the hourly check, across every ledger, and point Plaid's webhooks here
 * when PLAID_WEBHOOK_URL says where that is. Does nothing without Plaid keys
 * and a secret key: a Manilla that imports files only never needs either.
 */
export function startDailySync(log: (line: string) => void): void {
  const holder = globalThis as { [STARTED]?: boolean };
  if (holder[STARTED]) return;

  let deps: Deps;
  try {
    deps = { call: plaidCall(plaidConfigFromEnv()), key: secretKeyFromEnv() };
  } catch {
    log('bank feeds are off: PLAID_CLIENT_ID, PLAID_SECRET and MANILLA_SECRET_KEY are not all set');
    return;
  }
  holder[STARTED] = true;

  // Nobody is signed in at 3am; the audit trail says what did it instead.
  const check = () =>
    runAs({ id: null, name: 'Daily bank sync' }, () => syncAndTell((db) => connectionsDue(db, new Date()), deps, log));

  setTimeout(check, 60_000).unref();
  setInterval(check, CHECK_EVERY_MS).unref();

  const webhook = webhookUrlFromEnv();
  if (webhook) {
    log(`bank feeds sync when Plaid says, at ${webhook}, and daily regardless`);
    void pointWebhooks(webhook, deps, log);
  } else {
    if (process.env.PLAID_WEBHOOK_URL) log('PLAID_WEBHOOK_URL is not an https:// address, so Plaid is not told it');
    log('bank feeds sync daily');
  }
}

/** Tell Plaid where each login's webhooks go, once the server is up. */
async function pointWebhooks(url: string, deps: Deps, log: (line: string) => void): Promise<void> {
  try {
    const ledgers = await listLedgers(homeDb(), databaseOf(process.env.DATABASE_URL ?? ''));
    const dbs = ledgers.map((ledger) => connectionFor(ledger.database));
    const { updated } = await registerWebhooks(dbs, url, deps, log);
    if (updated > 0) log(`Plaid's webhooks now come here for ${updated} bank ${updated === 1 ? 'login' : 'logins'}`);
  } catch (error) {
    // Not fatal: the daily sync still runs, and the next start tries again.
    log(`could not set Plaid's webhooks: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Sync the connections `pick` chooses in each ledger, and tell the phones what
 * came of it: the hourly check's due ones, or one bank's copies when Plaid says
 * it has something (webhook.ts).
 *
 * One run at a time. Each looks at a ledger before and after its sync to say
 * what the sync did, and two interleaved would each see the other's work and
 * announce it twice.
 */
export function syncAndTell(
  pick: (db: Database) => Promise<string[]>,
  deps: Deps,
  log: (line: string) => void,
): Promise<void> {
  return oneAtATime('sync-and-tell', async () => {
    const notifyUrl = process.env.MANILLA_SYNC_NOTIFY_URL;
    // What to say is worked out only when someone will hear it: the ntfy
    // topic, or a browser that turned on any of what a sync says.
    let telling = Boolean(notifyUrl);
    const outcomes: SyncOutcome[] = [];
    const after = new Map<string, LedgerAfterSync>();
    let ledgerCount = 0;
    try {
      const home = homeDb();
      for (const kind of ['sync', 'overspent', 'unusual'] as const) telling ||= await anyoneListening(home, kind);
      const ledgers = await listLedgers(home, databaseOf(process.env.DATABASE_URL ?? ''));
      ledgerCount = ledgers.length;
      for (const ledger of ledgers) {
        const db = connectionFor(ledger.database);
        const ids = await pick(db);
        // Most hours nothing is due, and then there is nothing to look at.
        if (ids.length === 0) continue;
        // A look before the sync, so afterwards it can say what the sync itself
        // did - the envelopes it took below zero, the income and the unusual
        // charges it brought in - rather than everything that is.
        const before = telling
          ? { envelopes: await listEnvelopes(db), unusual: await unusualCharges(db) }
          : { envelopes: [], unusual: [] };
        const reports: SyncReport[] = [];
        for (const id of ids) reports.push(await syncConnection(db, id, { ...deps, account: home }));
        for (const report of reports) {
          const added = report.accounts.reduce((sum, account) => sum + account.added, 0);
          const held = report.accounts.reduce((sum, account) => sum + account.held, 0);
          if (telling) {
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
        if (telling) {
          const envelopes = await listEnvelopes(db);
          after.set(ledger.name, {
            waiting: await pendingCount(db),
            overdrawn: newlyOverdrawn(before.envelopes, envelopes),
            income: incomeArrived(before.envelopes, envelopes),
            unusual: newlyUnusual(before.unusual, await unusualCharges(db)),
          });
        }
      }
    } catch (error) {
      // One bad run is logged and the next one tries again; it must not take
      // the server down with it.
      log(`bank sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Whatever was synced before a failure is still worth saying.
    const notices = telling ? syncNotices(outcomes, after, { manyLedgers: ledgerCount > 1 }) : [];
    for (const notice of notices) {
      if (notifyUrl) await sendSyncNotice(notifyUrl, notice, process.env.MANILLA_ORIGIN);
      const { sent } = await notifyMembers(
        homeDb(),
        { kind: notice.kind },
        // The home screen, where every notice is.
        { title: TITLES[notice.kind], body: notice.text, path: '/', urgent: notice.priority === 'high' },
      );
      await sent;
    }
  });
}

/** What a person calls the bank: Plaid's institution name, when it gave one. */
async function bankName(db: Database, connectionId: string): Promise<string> {
  const [row] = await db
    .select({ name: bankConnections.institutionName })
    .from(bankConnections)
    .where(eq(bankConnections.id, connectionId));
  return row?.name ?? 'Your bank';
}
