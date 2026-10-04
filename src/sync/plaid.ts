/**
 * Plaid's /transactions/sync, read into Manilla's terms (FR-16 to FR-19).
 *
 * Three things differ from an OFX statement and are settled here, so nothing
 * downstream needs to know a transaction came from Plaid:
 *
 *   Amounts  A JSON number, positive for money out. The cents are read from
 *            the number's own digits, because JSON.parse would make it a float
 *            first, and the sign is turned round to OFX's: negative is out.
 *            More than two decimals is rounded and says so on the
 *            transaction, as an OFX amount would.
 *   Dates    `date` is already a calendar day and is checked, not converted.
 *            `datetime` is an instant and is deliberately never read.
 *   Pending  When a pending charge posts, Plaid adds a new transaction with a
 *            new id that names the pending one in `pending_transaction_id`, and
 *            lists the pending one in `removed`. planChanges() pairs the two,
 *            so a posting is one change to one transaction rather than a
 *            delete and an add (FR-19).
 */

import { formatCents, parseAmount } from '../money.ts';

export class PlaidDataError extends Error {}

export type PlaidTransaction = {
  /** Plaid's `transaction_id`. A pending charge and its posting have different ones. */
  id: string;
  /** Plaid's `account_id`, not the bank's account number. */
  accountId: string;
  /** Calendar date, `YYYY-MM-DD`: the posting date, or for a pending charge the day it was made. */
  date: string;
  /** The day the purchase was made, when the bank reports it separately. */
  authorizedDate?: string;
  /** Negative is money out, as in OFX. */
  amountCents: number;
  currency?: string;
  /** The bank's own text, before Plaid's clean-up, so the classifier sees what an OFX file would show. */
  description: string;
  /** Plaid's guess at the merchant. Kept apart from the description, never in place of it. */
  merchantName?: string;
  pending: boolean;
  /** On a posted transaction, the pending charge it replaces. */
  pendingId?: string;
  /** Non-fatal problems worth showing the user rather than swallowing. */
  warnings: string[];
};

export type PlaidRemoval = { id: string; accountId: string };

export type PlaidAccount = {
  id: string;
  name: string;
  /** The last digits of the account number, as the bank shows them. */
  mask?: string;
  type: string;
  subtype?: string;
  /**
   * Balances as Plaid reports them, sign included. For a credit account that
   * is what is owed, as a positive number; the sign is not turned round here
   * because what it is compared with decides which way is right.
   */
  currentCents?: number;
  availableCents?: number;
  currency?: string;
  warnings: string[];
};

export type SyncPage = {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: PlaidRemoval[];
  accounts: PlaidAccount[];
  nextCursor: string;
  hasMore: boolean;
  /** `transactions_update_status`: whether the first or the full history has arrived yet. */
  status?: string;
};

/**
 * A JSON number's own text, kept so cents can be read from its digits. Every
 * number in a response becomes one of these before anything reads it.
 */
type NumberText = { readonly numberText: string };

function isNumberText(value: unknown): value is NumberText {
  return typeof value === 'object' && value !== null && 'numberText' in value;
}

/** JSON.parse, with each number left as the text it was written as. */
export function parseJsonKeepingNumbers(text: string): unknown {
  return JSON.parse(text, (_key, value, context?: { source?: string }) => {
    if (typeof value !== 'number') return value;
    // Node 24's JSON.parse passes the source text; without it there is no
    // exact way to read the amount, so refuse rather than use the float.
    if (context?.source === undefined) {
      throw new PlaidDataError('This runtime does not give JSON.parse the source of numbers');
    }
    return { numberText: context.source } satisfies NumberText;
  });
}

/**
 * Cents from a JSON number's text. More than two decimals is rounded half-up,
 * as parseAmount rounds an OFX amount, and the warning says so. The warning is
 * written here rather than taken from parseAmount, whose guess that "1.234"
 * might be a thousands separator cannot apply to a JSON number. An exponent is
 * refused: no bank amount is written that way, so one means something is wrong.
 */
export function centsFromJsonNumber(value: unknown, what: string): { cents: number; warning?: string } {
  if (!isNumberText(value)) throw new PlaidDataError(`${what} is not a number`);
  const text = value.numberText;
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new PlaidDataError(`${what} is ${text}, which is not a plain decimal`);
  }
  const { cents } = parseAmount(text);
  const decimals = text.split('.')[1]?.length ?? 0;
  if (decimals <= 2) return { cents };
  // Unsigned, since which way is out differs between Plaid and Manilla and the
  // warning is only about the decimals.
  const unsigned = `${what} was ${text.replace(/^-/, '')}; rounded to ${formatCents(Math.abs(cents))}`;
  return { cents, warning: unsigned };
}

type Json = Record<string, unknown>;

function object(value: unknown, what: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isNumberText(value)) {
    throw new PlaidDataError(`${what} is not an object`);
  }
  return value as Json;
}

function array(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new PlaidDataError(`${what} is not a list`);
  return value;
}

function string(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw new PlaidDataError(`${what} is missing`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function calendarDate(value: unknown, what: string): string {
  const text = string(value, what);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new PlaidDataError(`${what} is ${text}, not a YYYY-MM-DD date`);
  return text;
}

function readTransaction(value: unknown, where: string): PlaidTransaction {
  const raw = object(value, where);
  const id = string(raw.transaction_id, `${where}: transaction_id`);
  const what = `Transaction ${id}`;
  if (typeof raw.pending !== 'boolean') throw new PlaidDataError(`${what}: pending is missing`);

  const authorizedDate =
    raw.authorized_date == null ? undefined : calendarDate(raw.authorized_date, `${what}: authorized_date`);
  const currency = optionalString(raw.iso_currency_code) ?? optionalString(raw.unofficial_currency_code);
  const merchantName = optionalString(raw.merchant_name);
  const pendingId = optionalString(raw.pending_transaction_id);
  // The amount is named without the id, since the warning sits on the transaction.
  const amount = centsFromJsonNumber(raw.amount, 'The amount');

  return {
    id,
    accountId: string(raw.account_id, `${what}: account_id`),
    date: calendarDate(raw.date, `${what}: date`),
    ...(authorizedDate ? { authorizedDate } : {}),
    // Plaid's positive is money out; OFX's, and so Manilla's, is money in.
    amountCents: -amount.cents,
    ...(currency ? { currency } : {}),
    description: optionalString(raw.original_description) ?? string(raw.name, `${what}: name`),
    ...(merchantName ? { merchantName } : {}),
    pending: raw.pending,
    ...(pendingId ? { pendingId } : {}),
    warnings: amount.warning ? [amount.warning] : [],
  };
}

function optionalCents(value: unknown, what: string, warnings: string[]): number | undefined {
  if (value == null) return undefined;
  const amount = centsFromJsonNumber(value, what);
  if (amount.warning) warnings.push(amount.warning);
  return amount.cents;
}

function readAccount(value: unknown, where: string): PlaidAccount {
  const raw = object(value, where);
  const id = string(raw.account_id, `${where}: account_id`);
  const what = `Account ${id}`;
  const balances = object(raw.balances, `${what}: balances`);
  const mask = optionalString(raw.mask);
  const subtype = optionalString(raw.subtype);
  const warnings: string[] = [];
  const currentCents = optionalCents(balances.current, 'The current balance', warnings);
  const availableCents = optionalCents(balances.available, 'The available balance', warnings);
  const currency =
    optionalString(balances.iso_currency_code) ?? optionalString(balances.unofficial_currency_code);

  return {
    id,
    name: string(raw.name, `${what}: name`),
    ...(mask ? { mask } : {}),
    type: string(raw.type, `${what}: type`),
    ...(subtype ? { subtype } : {}),
    ...(currentCents !== undefined ? { currentCents } : {}),
    ...(availableCents !== undefined ? { availableCents } : {}),
    ...(currency ? { currency } : {}),
    warnings,
  };
}

/** One page of a /transactions/sync response, from its raw text. */
export function parseSyncResponse(text: string): SyncPage {
  const raw = object(parseJsonKeepingNumbers(text), 'The response');
  if (typeof raw.has_more !== 'boolean') throw new PlaidDataError('The response has no has_more');
  const status = optionalString(raw.transactions_update_status);

  return {
    added: array(raw.added, 'added').map((t, i) => readTransaction(t, `added[${i}]`)),
    modified: array(raw.modified, 'modified').map((t, i) => readTransaction(t, `modified[${i}]`)),
    removed: array(raw.removed, 'removed').map((r, i) => {
      const removal = object(r, `removed[${i}]`);
      return {
        id: string(removal.transaction_id, `removed[${i}]: transaction_id`),
        accountId: string(removal.account_id, `removed[${i}]: account_id`),
      };
    }),
    accounts: array(raw.accounts ?? [], 'accounts').map((a, i) => readAccount(a, `accounts[${i}]`)),
    nextCursor: string(raw.next_cursor, 'next_cursor'),
    hasMore: raw.has_more,
    ...(status ? { status } : {}),
  };
}

export type SyncChange =
  | { kind: 'add'; transaction: PlaidTransaction }
  /**
   * A posted transaction that replaces a pending charge. If the pending one is
   * here it becomes this, keeping its envelope and its review; if it never
   * arrived, this is an add.
   */
  | { kind: 'post'; transaction: PlaidTransaction; pendingId: string }
  | { kind: 'update'; transaction: PlaidTransaction }
  /**
   * The bank no longer reports this transaction. A pending charge that fell
   * away, or one Plaid withdrew; never the pending side of a posting, which
   * arrives as part of a `post`.
   */
  | { kind: 'remove'; id: string; accountId: string };

/**
 * What one sync means for the ledger, in the order to apply it.
 *
 * A removal of a pending charge whose posting is in the same batch is folded
 * into that posting. One whose posting came in an earlier sync is still
 * listed, and has to be ignored by whatever applies it if that id now belongs
 * to a posted transaction, or it would delete the posting.
 */
export function planChanges(changes: Pick<SyncPage, 'added' | 'modified' | 'removed'>): SyncChange[] {
  const postedOver = new Set<string>();
  const plan: SyncChange[] = [];

  for (const transaction of changes.added) {
    if (!transaction.pending && transaction.pendingId) {
      postedOver.add(transaction.pendingId);
      plan.push({ kind: 'post', transaction, pendingId: transaction.pendingId });
    } else {
      plan.push({ kind: 'add', transaction });
    }
  }
  for (const transaction of changes.modified) plan.push({ kind: 'update', transaction });
  for (const removal of changes.removed) {
    if (!postedOver.has(removal.id)) plan.push({ kind: 'remove', ...removal });
  }
  return plan;
}
