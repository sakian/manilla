/**
 * Plaid responses for tests, written as Plaid writes them. Not a test file
 * itself: `npm test` runs `*.test.ts`, and these are what they share.
 */

/**
 * A response page as Plaid would write it. Amounts are given as the text of
 * the JSON number, since what is being tested is how that text is read.
 */
export function page(parts: {
  added?: Record<string, unknown>[];
  modified?: Record<string, unknown>[];
  removed?: { transaction_id: string; account_id: string }[];
  next_cursor?: string;
  has_more?: boolean;
}): string {
  const json = JSON.stringify({
    accounts: [],
    added: parts.added ?? [],
    modified: parts.modified ?? [],
    removed: parts.removed ?? [],
    next_cursor: parts.next_cursor ?? 'cursor-1',
    has_more: parts.has_more ?? false,
    transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
  });
  return json.replace(/"@number:([^"]*)"/g, '$1');
}

export function transaction(fields: Record<string, unknown> & { amount: string }): Record<string, unknown> {
  return {
    transaction_id: 'txn-1',
    account_id: 'acct-1',
    date: '2026-09-03',
    authorized_date: null,
    iso_currency_code: 'CAD',
    name: 'GROCERY 1234',
    merchant_name: null,
    pending: false,
    pending_transaction_id: null,
    ...fields,
    amount: `@number:${fields.amount}`,
  };
}
