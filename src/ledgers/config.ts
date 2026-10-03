/**
 * Which ledgers this Manilla keeps, and which one a request is looking at (#23).
 *
 * A ledger is a whole Manilla's worth of money - accounts, envelopes, history -
 * in a Postgres database of its own on the same server. Two ledgers share
 * nothing but the sign-in: business and household books kept apart, with the
 * money that moves between them entered on each side by hand.
 *
 * A database each, rather than a ledger column on every table, because then no
 * query can mix them: the invariant, the income pool, rules, suggestions and
 * every report are already one-database things and stay correct without being
 * told. A schema each was the other way to get that, and is ruled out by the
 * migrations, which name `"public"` throughout.
 *
 * Configured as `MANILLA_LEDGERS="Personal=manilla,Business=manilla_business"`:
 * a name to show, and the database it lives in. Unset, there is one ledger -
 * the database in DATABASE_URL - and nothing about the app changes.
 */

export class LedgerConfigError extends Error {}

export type Ledger = {
  /** Stable identity, used in the cookie: the database name. */
  key: string;
  /** What the screens call it. */
  name: string;
  database: string;
};

/**
 * Database names Manilla will create and connect to. Deliberately narrower than
 * what Postgres allows: the name ends up in a `create database` statement and a
 * backup's filename, and a hyphen would make `manilla-x-2026-10-03.dump`
 * ambiguous with the home ledger's `manilla-2026-10-03.dump`.
 */
const DATABASE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** The database a Postgres URL points at. */
export function databaseOf(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!name) throw new LedgerConfigError('DATABASE_URL does not name a database.');
  return name;
}

/** The same server and credentials, another database. */
export function urlFor(homeUrl: string, database: string): string {
  const url = new URL(homeUrl);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

/**
 * Read `MANILLA_LEDGERS`, failing on anything ambiguous.
 *
 * The home database - the one in DATABASE_URL, which holds sign-in - must be
 * one of the ledgers. Leaving it out would not lose anything, but it would hide
 * every transaction recorded before the second ledger was added, and the first
 * person to notice would think them gone.
 */
export function parseLedgers(spec: string | undefined, homeDatabase: string): Ledger[] {
  const trimmed = spec?.trim() ?? '';
  if (trimmed === '') {
    return [{ key: homeDatabase, name: 'Manilla', database: homeDatabase }];
  }

  const ledgers: Ledger[] = [];
  for (const part of trimmed.split(',')) {
    const entry = part.trim();
    if (entry === '') continue;

    const equals = entry.lastIndexOf('=');
    if (equals <= 0) {
      throw new LedgerConfigError(
        `MANILLA_LEDGERS entry "${entry}" should be Name=database, e.g. Business=manilla_business.`,
      );
    }
    const name = entry.slice(0, equals).trim();
    const database = entry.slice(equals + 1).trim();

    if (name === '' || name.length > 40) {
      throw new LedgerConfigError(`A ledger name must be 1 to 40 characters; got "${name}".`);
    }
    if (!DATABASE_NAME.test(database)) {
      throw new LedgerConfigError(
        `"${database}" cannot be a ledger's database: use lowercase letters, digits and _, ` +
          'starting with a letter.',
      );
    }
    if (ledgers.some((ledger) => ledger.database === database)) {
      throw new LedgerConfigError(`Database "${database}" is listed twice in MANILLA_LEDGERS.`);
    }
    if (ledgers.some((ledger) => ledger.name.toLowerCase() === name.toLowerCase())) {
      throw new LedgerConfigError(`Two ledgers are called "${name}"; they need telling apart.`);
    }
    ledgers.push({ key: database, name, database });
  }

  if (!ledgers.some((ledger) => ledger.database === homeDatabase)) {
    throw new LedgerConfigError(
      `MANILLA_LEDGERS must include ${homeDatabase}, the database in DATABASE_URL: it holds ` +
        'sign-in, and everything recorded before a second ledger was added.',
    );
  }
  return ledgers;
}

/**
 * The ledger a request asked for, or the first one.
 *
 * The cookie naming it is the browser's say, so it is only ever looked up in
 * the configured list, never used as a database name. One that names a ledger
 * since removed falls back rather than failing, since the person can do nothing
 * about a cookie they cannot see.
 */
export function chooseLedger(ledgers: Ledger[], requested: string | undefined): Ledger {
  return ledgers.find((ledger) => ledger.key === requested) ?? ledgers[0]!;
}

let configured: Ledger[] | undefined;

/** The ledgers this process was started with, read once. */
export function configuredLedgers(env: Record<string, string | undefined> = process.env): Ledger[] {
  if (env !== process.env) return parseLedgers(env.MANILLA_LEDGERS, homeDatabaseOf(env));
  configured ??= parseLedgers(env.MANILLA_LEDGERS, homeDatabaseOf(env));
  return configured;
}

function homeDatabaseOf(env: Record<string, string | undefined>): string {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new LedgerConfigError(
      'DATABASE_URL is not set. Copy .env.example to .env, or run `docker compose up -d db`.',
    );
  }
  return databaseOf(url);
}
