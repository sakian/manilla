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

  await migrateIfNeeded(production);
  await checkAuthConfig(production);
}

/**
 * Bring the database up to schema (NF-12).
 *
 * The Dockerfile has always shipped the migrations and the drizzle runtime into
 * the image "so the container can bring the database up to date on start" -
 * which nothing then did. A first deploy would have come up against an empty
 * database and failed somewhere far from the cause, and every later migration
 * would have been a step someone had to remember.
 *
 * Only in production, and only with a database URL. In development migrations
 * are `npm run db:migrate`, run deliberately, because `next dev` restarts on
 * every keystroke and a migration is not a thing to do by accident.
 */
async function migrateIfNeeded(production: boolean): Promise<void> {
  if (!production || !process.env.DATABASE_URL) return;

  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const { createDb } = await import('./db/client.ts');

  const db = createDb(process.env.DATABASE_URL);
  try {
    await migrate(db, { migrationsFolder: './db/migrations' });
    // A schema with no income pool is one every budget screen throws against
    // (#21), and the seed that used to make it is a development script.
    const { ensureIncomePool } = await import('./src/ledger/ledger.ts');
    await ensureIncomePool(db);
    console.log('[manilla] database is up to schema');

    // The count behind "N rules Manilla could write" is stored, and a deploy
    // can change the answer without any action to redo it - raising the
    // threshold left a count of 24 pointing at a page with none. A wrong count
    // is not worth refusing to start over.
    try {
      const { refreshRuleSuggestionCount } = await import('./src/rules/rules.ts');
      await refreshRuleSuggestionCount(db);
    } catch (error) {
      console.warn('[manilla] could not recount rule suggestions:', error);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Serving against a schema we could not bring up to date is how a ledger
    // ends up half-written, so this is fatal rather than a warning.
    throw new Error(`Manilla refuses to start: migrations failed: ${message}`);
  } finally {
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
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
