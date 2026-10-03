/**
 * What a ledger is, and the rules for naming one (#23).
 *
 * A ledger is a whole Manilla's worth of money - accounts, envelopes, history -
 * in a Postgres database of its own on the same server. Ledgers share nothing
 * but the sign-in: business and household books kept apart, with the money
 * that moves between them entered on each side by hand.
 *
 * A database each, rather than a ledger column on every table, because then no
 * query can mix them: the invariant, the income pool, rules, suggestions and
 * every report are already one-database things and stay correct without being
 * told. A schema each was the other way to get that, and is ruled out by the
 * migrations, which name `"public"` throughout.
 *
 * The home ledger is the database in DATABASE_URL, which also holds sign-in.
 * The others are opened from Settings and listed in its `ledgers` table
 * (registry.ts).
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
 * The home ledger's name, as an app setting in the home database: kept with
 * the account, so erasing the ledger's data keeps what it is called.
 */
export const HOME_LEDGER_NAME_KEY = 'home_ledger_name';

/** Four in all, the home one included - and four colours to tell them apart. */
export const MAX_LEDGERS = 4;

/**
 * Database names Manilla will create. Deliberately narrower than what Postgres
 * allows: the name ends up in a `create database` statement and a backup's
 * filename, and a hyphen would make `manilla-x-2026-10-03.dump` ambiguous with
 * the home ledger's `manilla-2026-10-03.dump`.
 */
export const DATABASE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

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

/** A ledger's name as typed, trimmed, or a reason it will not do. */
export function cleanLedgerName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (trimmed === '') throw new LedgerConfigError('A ledger needs a name.');
  if (trimmed.length > 40) {
    throw new LedgerConfigError('A ledger name can be up to 40 characters.');
  }
  return trimmed;
}

/**
 * The database a new ledger called `name` gets: `<home>_ledger_<name>`.
 *
 * The `_ledger_` keeps every one clear of the databases that are not ledgers
 * but share the prefix - `manilla_restore_check`, which a restore overwrites by
 * default, and the test suites' `manilla_test_*`. `taken` is every database
 * already on the server, so an existing one, ledger or not, is never adopted:
 * a clash gets a number instead.
 */
export function databaseNameFor(homeDatabase: string, name: string, taken: Set<string>): string {
  const prefix = DATABASE_NAME.test(homeDatabase) ? homeDatabase : 'manilla';
  const slug =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'book';
  // Room for a "_99" suffix inside Postgres's 63 characters.
  const base = `${prefix}_ledger_${slug}`.slice(0, 60).replace(/_+$/, '');

  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
  }
  throw new LedgerConfigError(`No free database name for "${name}".`);
}

/**
 * The ledger a request asked for, or the home one.
 *
 * The cookie naming it is the browser's say, so it is only ever looked up in
 * the list, never used as a database name. One that names a ledger since
 * removed falls back rather than failing, since the person can do nothing
 * about a cookie they cannot see.
 */
export function chooseLedger(ledgers: Ledger[], requested: string | undefined): Ledger {
  return ledgers.find((ledger) => ledger.key === requested) ?? ledgers[0]!;
}
