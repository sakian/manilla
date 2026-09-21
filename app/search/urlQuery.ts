/**
 * The search filters, as they live in the URL (VW-5, VW-6).
 *
 * In the URL rather than in component state, for the same reason the reports
 * period is: a search worth doing is worth bookmarking, reloading, sharing with
 * yourself on a phone, and downloading as a CSV that covers exactly what is on
 * screen. One reader and one writer here means the page, the account view and
 * the CSV route cannot form three different opinions about what `?min=50` meant.
 *
 * Amounts are dollars in the URL because that is what a person typed; they
 * become cents at this boundary and stay cents everywhere inside (NF-1).
 */

import { parseAmount } from '../../src/money.ts';
import {
  MAX_LIMIT,
  SORT_FIELDS,
  type SortField,
  type TransactionQuery,
} from '../../src/transactions/search.ts';

export type Params = Record<string, string | string[] | undefined>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function one(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Repeatable params arrive as an array from one shape of URL and a string from
 * another.
 *
 * `all` is dropped: an account's own page uses it to mean "every account", and it
 * must never reach a query as an id - the columns are uuids, so Postgres would
 * refuse the whole request rather than return nothing.
 */
function many(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter((item) => item !== '' && item !== 'all');
}

function cents(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  try {
    // Only the size matters: the range is compared against the magnitude, so a
    // stray minus sign in a hand-edited URL is dropped rather than obeyed.
    return Math.abs(parseAmount(value).cents);
  } catch {
    return undefined;
  }
}

function day(value: string | undefined): string | undefined {
  return value && DAY.test(value) ? value : undefined;
}

export const PAGE_SIZE = 50;

/**
 * Read the filters out of a query string.
 *
 * Anything unparseable is dropped rather than refused: a URL is typed and edited
 * by hand, and losing one filter beats an error page in place of the results.
 */
export function readQuery(params: Params, options: { pageSize?: number } = {}): TransactionQuery {
  const pageSize = Math.min(options.pageSize ?? PAGE_SIZE, MAX_LIMIT);
  const page = Math.max(1, Number(one(params.page) ?? 1) || 1);

  const status = one(params.status);
  const kind = one(params.kind);
  const direction = one(params.dir);
  const sort = one(params.sort);
  const order = one(params.order);

  return {
    ...(one(params.q) ? { text: one(params.q)! } : {}),
    ...(many(params.account).length > 0 ? { accountIds: many(params.account) } : {}),
    ...(many(params.env).length > 0 ? { envelopeIds: many(params.env) } : {}),
    ...(status === 'pending_review' || status === 'confirmed' ? { status } : {}),
    ...(kind === 'spending' || kind === 'account_transfer' ? { kind } : {}),
    ...(day(one(params.from)) ? { from: day(one(params.from))! } : {}),
    ...(day(one(params.to)) ? { to: day(one(params.to))! } : {}),
    ...(cents(one(params.min)) !== undefined ? { minCents: cents(one(params.min))! } : {}),
    ...(cents(one(params.max)) !== undefined ? { maxCents: cents(one(params.max))! } : {}),
    ...(direction === 'in' || direction === 'out' ? { direction } : {}),
    ...(isSortField(sort) ? { sort } : {}),
    ...(order === 'asc' || order === 'desc' ? { order } : {}),
    limit: pageSize,
    offset: (page - 1) * pageSize,
  };
}

function isSortField(value: string | undefined): value is SortField {
  return value !== undefined && (SORT_FIELDS as readonly string[]).includes(value);
}

/** Which page the filters are on, 1-based, for the pager. */
export function readPage(params: Params): number {
  return Math.max(1, Number(one(params.page) ?? 1) || 1);
}

/**
 * The filter values as the form fields hold them: strings, because that is what
 * an `<input>` has, and unparsed, because a half-typed amount should stay on
 * screen while it is being typed.
 */
export type FormValues = {
  q: string;
  from: string;
  to: string;
  min: string;
  max: string;
  dir: string;
  status: string;
  kind: string;
  accounts: string[];
  envelopes: string[];
  sort: string;
  order: string;
};

export function readForm(params: Params): FormValues {
  return {
    q: one(params.q) ?? '',
    from: one(params.from) ?? '',
    to: one(params.to) ?? '',
    min: one(params.min) ?? '',
    max: one(params.max) ?? '',
    dir: one(params.dir) ?? '',
    status: one(params.status) ?? '',
    kind: one(params.kind) ?? '',
    accounts: many(params.account),
    envelopes: many(params.env),
    sort: one(params.sort) ?? 'date',
    order: one(params.order) ?? 'desc',
  };
}

/**
 * Turn form values back into a query string.
 *
 * Empty fields are left out rather than written as `&q=`, so the URL stays
 * readable and a shared link says only what was actually being filtered. The
 * page is dropped on purpose: changing a filter starts again at the first page,
 * because page 4 of a different search is not where anyone wants to land.
 */
export function writeQuery(values: Partial<FormValues>, extra: Params = {}): string {
  const params = new URLSearchParams();
  const put = (key: string, value: string | undefined) => {
    if (value && value.trim()) params.set(key, value.trim());
  };

  put('q', values.q);
  for (const id of values.accounts ?? []) params.append('account', id);
  for (const id of values.envelopes ?? []) params.append('env', id);
  put('from', values.from);
  put('to', values.to);
  put('min', values.min);
  put('max', values.max);
  put('dir', values.dir);
  put('status', values.status);
  put('kind', values.kind);
  if (values.sort && values.sort !== 'date') put('sort', values.sort);
  if (values.order && values.order !== 'desc') put('order', values.order);

  for (const [key, value] of Object.entries(extra)) {
    const single = one(value);
    if (single) params.set(key, single);
  }

  return params.toString();
}

/**
 * A link to the same search on another page, or to the CSV of it.
 *
 * Built by copying the params rather than round-tripping through `FormValues`,
 * so a filter this file does not know about - one added later, or one typed by
 * hand - survives paging instead of being quietly dropped.
 */
export function withParams(
  path: string,
  params: Params,
  page = 1,
  override: Params = {},
): string {
  const query = new URLSearchParams();
  const all = { ...params, ...override };

  for (const [key, value] of Object.entries(all)) {
    if (key === 'page') continue;
    const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
    for (const item of values) {
      if (item.trim()) query.append(key, item);
    }
  }
  if (page > 1) query.set('page', String(page));

  const text = query.toString();
  return text ? `${path}?${text}` : path;
}
