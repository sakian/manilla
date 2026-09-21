/**
 * Transaction search and filtering (VW-5, VW-6).
 *
 * One query behind two screens. The search page runs it with nothing pinned;
 * the account view runs it with `accountIds` pinned to the account being looked
 * at. That is deliberate: VW-5 and VW-6 ask for the same filters in two places,
 * and two implementations of "matching transactions" would eventually disagree
 * about what a split, a transfer or an uncategorized row is.
 *
 * Three decisions worth knowing about:
 *
 *  - **Amounts filter on magnitude, not sign.** Asked for "between $50 and
 *    $100", nobody means -100 to -50. Money out is the common case and it is
 *    stored negative, so the range is compared against the absolute value and
 *    `direction` is a separate filter for in versus out.
 *  - **Envelope matching is per line.** A split belongs to every envelope it
 *    was split across, so filtering by Groceries finds the grocery half of a
 *    Costco run. The transaction comes back whole, with its full amount, rather
 *    than sliced to the matching share - this is the ledger view, not a
 *    spending report, and RP-5's share arithmetic lives in `reports.ts`.
 *  - **Matches are counted, not just listed.** "37 transactions, $1,204.12" is
 *    the answer to half the questions anyone asks of a search box, and a page
 *    of 50 rows cannot give it.
 */

import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import {
  accountGroups,
  accounts,
  envelopeGroups,
  envelopes,
  transactions,
  txnLines,
} from '../../db/schema.ts';

/** A parenthesised, cast list, so an `in (...)` never has to be built by hand. */
function uuidList(ids: string[]): SQL {
  return sql`(${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

/** The pseudo-envelope meaning "no envelope at all": transfers, and unreviewed rows. */
export const UNCATEGORIZED = 'none';

export const SORT_FIELDS = ['date', 'amount', 'payee'] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export type Direction = 'in' | 'out';

export type TransactionQuery = {
  /** Matched against the payee as the bank wrote it, its normalized key, the memo and the cheque number. */
  text?: string;
  /** Just the payee, for when a word appears in both a name and a note. */
  payee?: string;
  /** Just the memo - the description a person or a bank added. */
  memo?: string;
  accountIds?: string[];
  /** Whole categories of account, so "everything in Day to day" is one filter. */
  accountGroupIds?: string[];
  /** Envelope ids, and/or {@link UNCATEGORIZED} for rows with no envelope. */
  envelopeIds?: string[];
  /** Whole groups of envelope, matched through any line's envelope. */
  envelopeGroupIds?: string[];
  status?: 'pending_review' | 'confirmed';
  kind?: 'spending' | 'account_transfer';
  from?: string;
  to?: string;
  /** Inclusive bounds on the size of the amount, ignoring its sign. */
  minCents?: number;
  maxCents?: number;
  direction?: Direction;
  sort?: SortField;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
};

export type FoundTransaction = {
  id: string;
  date: string;
  payeeRaw: string;
  amountCents: number;
  status: string;
  kind: string;
  memo: string | null;
  checkNumber: string | null;
  accountId: string;
  accountName: string;
  envelopeNames: string[];
  /** Set on an account transfer, so its two halves can be shown as one thing (FR-5). */
  transferPairId: string | null;
};

export type SearchResult = {
  rows: FoundTransaction[];
  /** Every match, not just this page. */
  total: number;
  /** What the matches sum to, signed, so money in and out cancel as they should. */
  totalCents: number;
  /** What was spent across the matches, as a positive number. */
  outCents: number;
  /** What came in across the matches, as a positive number. */
  inCents: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

/**
 * Everything the filters mean, in one place, so the row query and the totals
 * query cannot drift apart.
 *
 * Both correlated subqueries below name `transactions` literally rather than
 * interpolating the table. Drizzle renders a column reference unqualified when
 * the enclosing query has a single table, which turns `t.id = "id"` into a
 * condition Postgres resolves against the *inner* table - a query that runs,
 * returns the wrong rows, and looks fine. Writing the correlation out by hand
 * is the version that cannot quietly change meaning.
 */
function conditions(query: TransactionQuery): SQL[] {
  const where: SQL[] = [];

  const text = query.text?.trim();
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    where.push(
      or(
        sql`${transactions.payeeRaw} ilike ${like}`,
        sql`${transactions.payeeKey} ilike ${like}`,
        sql`${transactions.memo} ilike ${like}`,
        sql`${transactions.checkNumber} ilike ${like}`,
      )!,
    );
  }

  const like = (value: string) => `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

  const payee = query.payee?.trim();
  if (payee) {
    where.push(
      or(
        sql`${transactions.payeeRaw} ilike ${like(payee)}`,
        sql`${transactions.payeeKey} ilike ${like(payee)}`,
      )!,
    );
  }

  const memo = query.memo?.trim();
  if (memo) where.push(sql`${transactions.memo} ilike ${like(memo)}`);

  if (query.accountIds && query.accountIds.length > 0) {
    where.push(inArray(transactions.accountId, query.accountIds));
  }

  // A whole category of account. Not correlated, so there is no unqualified
  // column to bind to the wrong table.
  if (query.accountGroupIds && query.accountGroupIds.length > 0) {
    where.push(
      sql`${transactions.accountId} in (select a.id from accounts a where a.group_id in ${uuidList(
        query.accountGroupIds,
      )})`,
    );
  }

  // A whole group of envelope, through any of a split's lines. `transactions` is
  // named literally rather than interpolated: Drizzle renders a column reference
  // unqualified in a single-table query, and an unqualified name that also exists
  // inside the subquery binds there instead - a query that runs and lies.
  if (query.envelopeGroupIds && query.envelopeGroupIds.length > 0) {
    where.push(
      sql`exists (
        select 1 from txn_lines l
        join envelopes e on e.id = l.envelope_id
        where l.transaction_id = transactions.id and e.group_id in ${uuidList(
          query.envelopeGroupIds,
        )}
      )`,
    );
  }

  if (query.envelopeIds && query.envelopeIds.length > 0) {
    const named = query.envelopeIds.filter((id) => id !== UNCATEGORIZED);
    const wantsUncategorized = query.envelopeIds.includes(UNCATEGORIZED);

    const clauses: SQL[] = [];
    if (named.length > 0) {
      clauses.push(
        sql`exists (
          select 1 from txn_lines l
          where l.transaction_id = transactions.id and l.envelope_id in ${uuidList(named)}
        )`,
      );
    }
    if (wantsUncategorized) {
      clauses.push(sql`not exists (select 1 from txn_lines l where l.transaction_id = transactions.id)`);
    }
    where.push(clauses.length === 1 ? clauses[0]! : or(...clauses)!);
  }

  if (query.status) where.push(eq(transactions.status, query.status));
  if (query.kind) where.push(eq(transactions.kind, query.kind));
  if (query.from) where.push(gte(transactions.date, query.from));
  if (query.to) where.push(lte(transactions.date, query.to));

  // On the magnitude: see the note at the top of this file.
  if (query.minCents !== undefined) {
    where.push(sql`abs(${transactions.amountCents}) >= ${query.minCents}`);
  }
  if (query.maxCents !== undefined) {
    where.push(sql`abs(${transactions.amountCents}) <= ${query.maxCents}`);
  }

  if (query.direction === 'in') where.push(sql`${transactions.amountCents} > 0`);
  if (query.direction === 'out') where.push(sql`${transactions.amountCents} < 0`);

  return where;
}

function ordering(query: TransactionQuery) {
  const descending = (query.order ?? 'desc') === 'desc';
  const by = (column: SQLWrapper) => (descending ? desc(column) : asc(column));

  switch (query.sort ?? 'date') {
    case 'amount':
      // By size, not by sign: a $900 refund sorts with the $900 charges.
      return [by(sql`abs(${transactions.amountCents})`), desc(transactions.date)];
    case 'payee':
      return [by(transactions.payeeKey), desc(transactions.date)];
    default:
      return [by(transactions.date), by(transactions.createdAt)];
  }
}

/** Find transactions. Empty query means "everything, newest first". */
export async function searchTransactions(
  db: Database,
  query: TransactionQuery = {},
): Promise<SearchResult> {
  const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const offset = Math.max(0, query.offset ?? 0);
  const where = conditions(query);
  const filter = where.length > 0 ? and(...where)! : sql`true`;

  // The page of matching transactions. No join to lines here: a split would
  // arrive as several rows and quietly consume the page budget, so the
  // envelopes are fetched for this page afterwards.
  const found = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      payeeRaw: transactions.payeeRaw,
      amountCents: transactions.amountCents,
      status: transactions.status,
      kind: transactions.kind,
      memo: transactions.memo,
      checkNumber: transactions.checkNumber,
      transferPairId: transactions.transferPairId,
      accountId: transactions.accountId,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(filter)
    .orderBy(...ordering(query))
    .limit(limit)
    .offset(offset);

  const [totals] = await db
    .select({
      total: sql<string>`count(*)::bigint`,
      totalCents: sql<string>`coalesce(sum(${transactions.amountCents}), 0)::bigint`,
      outCents: sql<string>`coalesce(-sum(${transactions.amountCents}) filter (where ${transactions.amountCents} < 0), 0)::bigint`,
      inCents: sql<string>`coalesce(sum(${transactions.amountCents}) filter (where ${transactions.amountCents} > 0), 0)::bigint`,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(filter);

  const envelopeNames = await namesForPage(db, found.map((row) => row.id));
  const total = Number(totals?.total ?? 0);

  return {
    rows: found.map((row) => ({
      ...row,
      amountCents: Number(row.amountCents),
      envelopeNames: envelopeNames.get(row.id) ?? [],
    })),
    total,
    totalCents: Number(totals?.totalCents ?? 0),
    outCents: Number(totals?.outCents ?? 0),
    inCents: Number(totals?.inCents ?? 0),
    limit,
    offset,
    hasMore: offset + found.length < total,
  };
}

/** The envelopes behind one page of results, in the order they were split. */
async function namesForPage(db: Database, ids: string[]): Promise<Map<string, string[]>> {
  if (ids.length === 0) return new Map();

  const rows = await db
    .select({
      transactionId: txnLines.transactionId,
      name: envelopes.name,
      amountCents: txnLines.amountCents,
    })
    .from(txnLines)
    .innerJoin(envelopes, eq(envelopes.id, txnLines.envelopeId))
    .where(inArray(txnLines.transactionId, ids))
    .orderBy(asc(sql`abs(${txnLines.amountCents})`));

  const byId = new Map<string, string[]>();
  for (const row of rows) {
    const names = byId.get(row.transactionId) ?? [];
    names.push(row.name);
    byId.set(row.transactionId, names);
  }
  return byId;
}

export type FilterChoices = {
  accounts: { id: string; name: string; archived: boolean }[];
  accountGroups: { id: string; name: string }[];
  envelopes: { id: string; name: string; groupName: string }[];
  envelopeGroups: { id: string; name: string }[];
};

/** What the filter controls can offer. Archived accounts are listed but marked. */
export async function filterChoices(db: Database): Promise<FilterChoices> {
  const accountRows = await db
    .select({ id: accounts.id, name: accounts.name, archivedAt: accounts.archivedAt })
    .from(accounts)
    .orderBy(asc(accounts.position), asc(accounts.name));

  const envelopeRows = await db
    .select({
      id: envelopes.id,
      name: envelopes.name,
      groupName: sql<string>`(select g.name from envelope_groups g where g.id = envelopes.group_id)`,
    })
    .from(envelopes)
    .where(isNull(envelopes.archivedAt))
    .orderBy(asc(envelopes.name));

  const accountGroupRows = await db
    .select({ id: accountGroups.id, name: accountGroups.name })
    .from(accountGroups)
    .where(isNull(accountGroups.archivedAt))
    .orderBy(asc(accountGroups.position), asc(accountGroups.name));

  const envelopeGroupRows = await db
    .select({ id: envelopeGroups.id, name: envelopeGroups.name })
    .from(envelopeGroups)
    .where(isNull(envelopeGroups.archivedAt))
    .orderBy(asc(envelopeGroups.position), asc(envelopeGroups.name));

  return {
    accounts: accountRows.map((row) => ({
      id: row.id,
      name: row.name,
      archived: row.archivedAt !== null,
    })),
    accountGroups: accountGroupRows,
    envelopes: envelopeRows,
    envelopeGroups: envelopeGroupRows,
  };
}

/**
 * A one-line description of what is being shown, in words.
 *
 * No screen calls this today: the transactions view names a single envelope or
 * account in its heading and leaves the rest to the filter controls themselves.
 * It stays because putting a query into a sentence is a question about the query,
 * not about a screen - and because the next thing that wants to say what it is
 * showing, a CSV header or a saved search, should not write its own version.
 */
export function describeQuery(
  query: TransactionQuery,
  names: {
    accounts?: Map<string, string>;
    accountGroups?: Map<string, string>;
    envelopes?: Map<string, string>;
    envelopeGroups?: Map<string, string>;
  } = {},
): string {
  const parts: string[] = [];

  if (query.text) parts.push(`matching “${query.text}”`);
  if (query.payee) parts.push(`paid to “${query.payee}”`);
  if (query.memo) parts.push(`noted “${query.memo}”`);
  if (query.direction === 'in') parts.push('money in');
  if (query.direction === 'out') parts.push('money out');
  if (query.kind === 'account_transfer') parts.push('transfers between accounts');
  if (query.status === 'pending_review') parts.push('awaiting review');
  if (query.status === 'confirmed') parts.push('confirmed');

  if (query.accountIds?.length) {
    const labels = query.accountIds.map((id) => names.accounts?.get(id) ?? 'an account');
    parts.push(`in ${labels.join(' or ')}`);
  }
  if (query.accountGroupIds?.length) {
    const labels = query.accountGroupIds.map(
      (id) => names.accountGroups?.get(id) ?? 'a category of account',
    );
    parts.push(`in ${labels.join(' or ')}`);
  }
  if (query.envelopeIds?.length) {
    const labels = query.envelopeIds.map((id) =>
      id === UNCATEGORIZED ? 'no envelope' : (names.envelopes?.get(id) ?? 'an envelope'),
    );
    parts.push(`from ${labels.join(' or ')}`);
  }
  if (query.envelopeGroupIds?.length) {
    const labels = query.envelopeGroupIds.map(
      (id) => names.envelopeGroups?.get(id) ?? 'a group of envelope',
    );
    parts.push(`from ${labels.join(' or ')}`);
  }

  if (query.minCents !== undefined && query.maxCents !== undefined) {
    parts.push(`between ${dollars(query.minCents)} and ${dollars(query.maxCents)}`);
  } else if (query.minCents !== undefined) {
    parts.push(`${dollars(query.minCents)} or more`);
  } else if (query.maxCents !== undefined) {
    parts.push(`up to ${dollars(query.maxCents)}`);
  }

  if (query.from && query.to) parts.push(`between ${query.from} and ${query.to}`);
  else if (query.from) parts.push(`on or after ${query.from}`);
  else if (query.to) parts.push(`on or before ${query.to}`);

  return parts.length === 0 ? 'Everything, newest first' : `Transactions ${parts.join(', ')}`;
}

function dollars(cents: number): string {
  const whole = Math.floor(cents / 100).toLocaleString('en-CA');
  return `$${whole}.${String(cents % 100).padStart(2, '0')}`;
}

/** True when nothing is being filtered, so the UI can say "everything". */
export function isEmptyQuery(query: TransactionQuery): boolean {
  return (
    !query.text?.trim() &&
    !query.payee?.trim() &&
    !query.memo?.trim() &&
    !query.accountIds?.length &&
    !query.accountGroupIds?.length &&
    !query.envelopeIds?.length &&
    !query.envelopeGroupIds?.length &&
    !query.status &&
    !query.kind &&
    !query.from &&
    !query.to &&
    query.minCents === undefined &&
    query.maxCents === undefined &&
    !query.direction
  );
}
