/**
 * The two things that mean Manilla itself needs looking at, told to a phone as
 * they start (#87): a ledger whose envelopes and accounts no longer add up
 * (FR-37), and a server disk filling towards the point where every write stops.
 *
 * Both already show on the home screen, which is no use when nobody opens it -
 * and a full disk is exactly what a quiet week hides. So an hourly look, and a
 * notification only when a problem starts or gets worse. While it lasts, it
 * stays on the home screen and is not said again; once it clears, a return is
 * news again.
 *
 * Checked whether or not bank feeds are on: a ledger can stop adding up after
 * an import as easily as after a sync.
 */

import { eq } from 'drizzle-orm';
import { connectionFor, homeDb, type Database } from '../../db/client.ts';
import { appSettings } from '../../db/schema.ts';
import { databaseOf } from '../ledgers/config.ts';
import { listLedgers } from '../ledgers/registry.ts';
import { checkInvariant } from '../ledger/ledger.ts';
import { DISK_BAD, DISK_WARN } from '../notices/notices.ts';
import { diskUsedShare } from '../system/disk.ts';
import { anyoneListening, notifyMembers } from './push.ts';

/** What has been said and not yet cleared. */
export type ProblemsTold = {
  /** Ledgers (by database) already said not to add up. */
  mismatched: string[];
  disk: 'warn' | 'bad' | null;
};

export type ProblemsSeen = {
  ledgers: { key: string; name: string; ok: boolean }[];
  /** Share of the disk in use, 0 to 1, or null when it could not be read. */
  disk: number | null;
};

export const NOTHING_TOLD: ProblemsTold = { mismatched: [], disk: null };

/**
 * A disk that has been said to be filling is not said to have recovered until
 * it is this far under the line, so one hovering at 90% is not news every hour.
 */
const DISK_SETTLED = DISK_WARN - 0.03;

const RANK = { warn: 1, bad: 2 } as const;

/** What to say, if anything (`text` null for nothing), and what will then have been said. */
export function problemsToTell(
  told: ProblemsTold,
  seen: ProblemsSeen,
): { text: string | null; urgent: boolean; told: ProblemsTold } {
  const lines: string[] = [];
  let urgent = false;
  const prefix = (name: string) => (seen.ledgers.length > 1 ? `${name}: ` : '');

  const mismatched = seen.ledgers.filter((ledger) => !ledger.ok);
  for (const ledger of mismatched) {
    if (told.mismatched.includes(ledger.key)) continue;
    urgent = true;
    lines.push(`${prefix(ledger.name)}The envelopes and the accounts no longer add up. Open Manilla before trusting any figure in it.`);
  }

  // Unreadable is not the same as fine: what was said stands until a reading says otherwise.
  let disk = told.disk;
  if (seen.disk !== null) {
    const level = seen.disk >= DISK_BAD ? 'bad' : seen.disk >= DISK_WARN ? 'warn' : null;
    if (level && (disk === null || RANK[level] > RANK[disk])) {
      urgent ||= level === 'bad';
      lines.push(
        `The server's disk is ${Math.round(seen.disk * 100)}% full. When it fills, Manilla stops saving changes, and the backups stop with it.`,
      );
      disk = level;
    } else if (!level && seen.disk < DISK_SETTLED) {
      disk = null;
    }
  }

  return {
    text: lines.length > 0 ? lines.join('\n') : null,
    urgent,
    told: { mismatched: mismatched.map((ledger) => ledger.key).sort(), disk },
  };
}

export const TOLD_KEY = 'push_problems_told';

async function readTold(home: Database): Promise<ProblemsTold> {
  const [row] = await home.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, TOLD_KEY));
  try {
    return row ? { ...NOTHING_TOLD, ...(JSON.parse(row.value) as Partial<ProblemsTold>) } : NOTHING_TOLD;
  } catch {
    return NOTHING_TOLD;
  }
}

async function writeTold(home: Database, told: ProblemsTold): Promise<void> {
  const value = JSON.stringify(told);
  await home
    .insert(appSettings)
    .values({ key: TOLD_KEY, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

/**
 * One look. Nothing is worked out when nobody has Problems turned on, so
 * whoever turns it on later hears about one that was already there.
 */
export async function checkForProblems(
  home: Database,
  options: { homeDatabase: string; ledgerDb?: (database: string) => Database; disk?: () => Promise<number | null>; fetch?: typeof fetch },
): Promise<string | null> {
  if (!(await anyoneListening(home, 'problems'))) return null;
  const ledgers = await listLedgers(home, options.homeDatabase);
  const seen: ProblemsSeen = {
    ledgers: await Promise.all(
      ledgers.map(async (ledger) => ({
        key: ledger.key,
        name: ledger.name,
        ok: (await checkInvariant((options.ledgerDb ?? connectionFor)(ledger.database))).ok,
      })),
    ),
    disk: await (options.disk ?? diskUsedShare)(),
  };
  const told = await readTold(home);
  const outcome = problemsToTell(told, seen);
  // Written before sending: a push service that is down must not make the next hour say it again.
  if (JSON.stringify(outcome.told) !== JSON.stringify(told)) await writeTold(home, outcome.told);
  if (outcome.text === null) return null;
  const { sent } = await notifyMembers(
    home,
    { kind: 'problems' },
    { title: 'Manilla needs a look', body: outcome.text, path: '/', urgent: outcome.urgent },
    { fetch: options.fetch },
  );
  await sent;
  return outcome.text;
}

const STARTED = Symbol.for('manilla.problemWatch');
const EVERY_MS = 60 * 60 * 1000;

/** Start the hourly look, once per process. */
export function startProblemWatch(log: (line: string) => void): void {
  const holder = globalThis as { [STARTED]?: boolean };
  if (holder[STARTED]) return;
  holder[STARTED] = true;

  const look = async () => {
    try {
      const said = await checkForProblems(homeDb(), { homeDatabase: databaseOf(process.env.DATABASE_URL ?? '') });
      if (said) log(`told phones: ${said.replaceAll('\n', ' ')}`);
    } catch (error) {
      log(`the problem check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  setTimeout(look, 90_000).unref();
  setInterval(look, EVERY_MS).unref();
}
