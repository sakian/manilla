/**
 * Boot-time work.
 *
 * `register()` runs once and must finish before the server accepts requests,
 * which makes it the right place for the two things that have to be true before
 * anything else happens: the schema is current, and the configuration will not
 * quietly issue sessions for the wrong origin.
 *
 * Both fail loudly in production and softly in development, for the same reason:
 * a checkout with no `.env` should still come up under `next dev`, and a server
 * that is wrong about either of these should not serve at all.
 */

export async function register(): Promise<void> {
  const production = process.env.NODE_ENV === 'production';

  try {
    await migrateIfNeeded(production);
    await checkAuthConfig(production);
    await checkTimeZone(production);
    await startBankSync(production);
    await startProblemWatch(production);
  } catch (error) {
    // Next runs this once and, when it throws, keeps the process up answering
    // every request with a 500 - so `restart: unless-stopped` never fires and
    // nothing short of a hand restart recovers. Exiting hands the retry to
    // Docker, and the reason stays in `docker compose logs app`.
    if (!production || process.env.NEXT_RUNTIME !== 'nodejs') throw error;
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * Look hourly for a ledger that no longer adds up or a disk filling, and tell
 * the phones that asked (#87). Production only, like the bank sync, and
 * whether or not bank feeds are on.
 */
async function startProblemWatch(production: boolean): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (!production || !process.env.DATABASE_URL) return;
  const { startProblemWatch } = await import('./src/push/problems.ts');
  startProblemWatch((line) => console.log(`[manilla] ${line}`));
}

/**
 * Sync linked bank accounts about once a day (FR-16). Only in production, for
 * the reason migrations are: `next dev` pointed at a ledger should not start
 * fetching from a bank because it was started. In development a sync is the
 * Sync now button.
 */
async function startBankSync(production: boolean): Promise<void> {
  // A timer and node:crypto, so Node's runtime only; checked this way so the
  // Edge build drops the import rather than warning about it.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (!production || !process.env.DATABASE_URL) return;
  const { startDailySync } = await import('./src/sync/schedule.ts');
  startDailySync((line) => console.log(`[manilla] ${line}`));
}

/**
 * Say whose calendar "today" is. Dates are calendar days read off the server's
 * local clock (src/budget/month.ts), and a container's local zone is UTC unless
 * MANILLA_TIMEZONE says otherwise - which in the Americas makes every evening
 * tomorrow and the last evening of a month next month. A warning rather than a
 * refusal: it is wrong by hours, not wrong about money, and a server that will
 * not start is worse.
 */
async function checkTimeZone(production: boolean): Promise<void> {
  const { localToday } = await import('./src/budget/month.ts');
  // A name the runtime does not know leaves no zone at all, and the clock on UTC.
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone as string | undefined;
  if (!zone) {
    console.warn(`[manilla] "${process.env.TZ}" is not a timezone name, so calendar days are UTC's`);
    return;
  }
  console.log(`[manilla] calendar days are ${zone}'s; today is ${localToday()}`);
  if (production && /^(Etc\/)?(UTC|GMT|Universal|Zulu)$/.test(zone)) {
    console.warn(
      '[manilla] the server is on UTC, so evenings fall on the next day. ' +
        'Set MANILLA_TIMEZONE in .env to your own zone, e.g. America/Toronto.',
    );
  }
}

/**
 * Bring every ledger's database up to schema (NF-12, LG-7).
 *
 * The Dockerfile has always shipped the migrations and the drizzle runtime into
 * the image "so the container can bring the database up to date on start" -
 * which nothing then did. A first deploy would have come up against an empty
 * database and failed somewhere far from the cause, and every later migration
 * would have been a step someone had to remember. Every ledger opened from
 * Settings is migrated too, the home one first since it holds the list.
 *
 * Only in production, and only with a database URL. In development migrations
 * are `npm run db:migrate`, run deliberately, because `next dev` restarts on
 * every keystroke and a migration is not a thing to do by accident.
 */
async function migrateIfNeeded(production: boolean): Promise<void> {
  if (!production || !process.env.DATABASE_URL) return;

  const { prepareEveryLedger } = await import('./src/ledgers/registry.ts');
  const { retryWhileDatabaseStarts, rootMessage } = await import('./src/ledgers/boot.ts');
  const databaseUrl = process.env.DATABASE_URL;
  const log = (line: string) => console.log(`[manilla] ${line}`);

  try {
    // After a power cut Postgres can still be recovering when this runs.
    await retryWhileDatabaseStarts(() => prepareEveryLedger(databaseUrl, log), { log });
  } catch (error) {
    const outer = error instanceof Error ? error.message : String(error);
    const root = rootMessage(error);
    const message = outer.includes(root) ? outer : `${outer} (${root})`;
    // Serving against a schema we could not bring up to date is how a ledger
    // ends up half-written, so this is fatal rather than a warning.
    throw new Error(`Manilla refuses to start: ${message}`);
  }
}

/**
 * Refuse a configuration that would issue sessions for the wrong origin.
 *
 * docker-compose.yml promises exactly this: in production a missing or localhost
 * relying-party ID stops the app rather than handing out credentials bound to a
 * host nobody will ever visit.
 */
async function checkAuthConfig(production: boolean): Promise<void> {
  const { authConfig } = await import('./src/auth/config.ts');

  try {
    const config = authConfig(process.env, production);
    console.log(`[manilla] passkeys bound to ${config.rpId} at ${config.origin}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (production) throw new Error(`Manilla refuses to start: ${message}`);
    console.warn(`[manilla] sign-in will not work until this is fixed: ${message}`);
  }
}
