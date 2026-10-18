/**
 * Credit card payments coming due, told to a phone (FR-38).
 *
 * The home screen already says so, but the trouble this is for is forgetting,
 * and forgetting means not opening the app. So an hourly look, and a
 * notification at each step towards the due date while the statement is not
 * covered: when the reminder starts, the day before, and once if the day
 * passes. Each step is said once, and none before morning.
 *
 * The card and the day only, never what is owed: a lock screen is read by
 * whoever is holding the phone.
 */

import { eq } from 'drizzle-orm';
import { connectionFor, homeDb, type Database } from '../../db/client.ts';
import { appSettings } from '../../db/schema.ts';
import { databaseOf } from '../ledgers/config.ts';
import { listLedgers } from '../ledgers/registry.ts';
import { cardPayments, needsReminder, type CardPayment } from '../accounts/bills.ts';
import { addDays, displayDate, localToday } from '../budget/month.ts';
import { anyoneListening, notifyMembers } from './push.ts';

/** How far along a reminder is: each is said once. */
export type Stage = 'soon' | 'tomorrow' | 'overdue';

const ORDER: Record<Stage, number> = { soon: 1, tomorrow: 2, overdue: 3 };

/** What has been said, by ledger, card and due date. */
export type BillsTold = Record<string, Stage>;

/** Not before this hour, local time: an hourly check would otherwise say it at 1am. */
export const EARLIEST_HOUR = 8;

export function stageOf(payment: CardPayment): Stage {
  return payment.daysLeft < 0 ? 'overdue' : payment.daysLeft <= 1 ? 'tomorrow' : 'soon';
}

function line(payment: CardPayment, today: string): string {
  switch (stageOf(payment)) {
    case 'overdue':
      return `${payment.name} was due ${displayDate(payment.dueDate, today)} and the statement isn't paid yet.`;
    case 'tomorrow':
      return `${payment.name} is due ${payment.daysLeft === 0 ? 'today' : 'tomorrow'} and the statement isn't paid yet.`;
    case 'soon':
      return `${payment.name} is due ${displayDate(payment.dueDate, today)}, in ${payment.daysLeft} days.`;
  }
}

/** What to say, if anything (`text` null for nothing), and what will then have been said. */
export function billsToTell(
  told: BillsTold,
  seen: { key: string; name: string; payments: CardPayment[] }[],
  today: string,
): { text: string | null; told: BillsTold } {
  const lines: string[] = [];
  const next: BillsTold = {};
  // Kept for a while after the due date, so a statement settled and then
  // un-settled is not news twice; then let go so the record does not grow.
  const forgetBefore = addDays(today, -40);
  for (const [key, stage] of Object.entries(told)) {
    if (key.slice(-10) >= forgetBefore) next[key] = stage;
  }
  for (const ledger of seen) {
    const prefix = seen.length > 1 ? `${ledger.name}: ` : '';
    for (const payment of ledger.payments.filter(needsReminder)) {
      const key = `${ledger.key}:${payment.accountId}:${payment.dueDate}`;
      const stage = stageOf(payment);
      const before = next[key];
      if (before && ORDER[before] >= ORDER[stage]) continue;
      next[key] = stage;
      lines.push(prefix + line(payment, today));
    }
  }
  return { text: lines.length > 0 ? lines.join('\n') : null, told: next };
}

export const TOLD_KEY = 'push_bills_told';

async function readTold(home: Database): Promise<BillsTold> {
  const [row] = await home.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, TOLD_KEY));
  try {
    return row ? (JSON.parse(row.value) as BillsTold) : {};
  } catch {
    return {};
  }
}

async function writeTold(home: Database, told: BillsTold): Promise<void> {
  const value = JSON.stringify(told);
  await home
    .insert(appSettings)
    .values({ key: TOLD_KEY, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

/** One look. Nothing is worked out when nobody has card payments turned on, or before morning. */
export async function checkForBills(
  home: Database,
  options: { homeDatabase: string; ledgerDb?: (database: string) => Database; now?: Date; fetch?: typeof fetch },
): Promise<string | null> {
  const now = options.now ?? new Date();
  if (now.getHours() < EARLIEST_HOUR) return null;
  if (!(await anyoneListening(home, 'bills'))) return null;
  const today = localToday(now);
  const ledgers = await listLedgers(home, options.homeDatabase);
  const seen = await Promise.all(
    ledgers.map(async (ledger) => ({
      key: ledger.key,
      name: ledger.name,
      payments: await cardPayments((options.ledgerDb ?? connectionFor)(ledger.database), today),
    })),
  );
  const told = await readTold(home);
  const outcome = billsToTell(told, seen, today);
  // Written before sending: a push service that is down must not make the next hour say it again.
  if (JSON.stringify(outcome.told) !== JSON.stringify(told)) await writeTold(home, outcome.told);
  if (outcome.text === null) return null;
  const { sent } = await notifyMembers(
    home,
    { kind: 'bills' },
    { title: 'Card payment due', body: outcome.text, path: '/', urgent: true },
    { fetch: options.fetch },
  );
  await sent;
  return outcome.text;
}

const STARTED = Symbol.for('manilla.billWatch');
const EVERY_MS = 60 * 60 * 1000;

/** Start the hourly look, once per process. */
export function startBillWatch(log: (line: string) => void): void {
  const holder = globalThis as { [STARTED]?: boolean };
  if (holder[STARTED]) return;
  holder[STARTED] = true;

  const look = async () => {
    try {
      const said = await checkForBills(homeDb(), { homeDatabase: databaseOf(process.env.DATABASE_URL ?? '') });
      if (said) log(`told phones: ${said.replaceAll('\n', ' ')}`);
    } catch (error) {
      log(`the card payment check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  setTimeout(look, 120_000).unref();
  setInterval(look, EVERY_MS).unref();
}
