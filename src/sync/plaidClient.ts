/**
 * The few Plaid endpoints Manilla calls, over plain fetch.
 *
 * Responses come back as text rather than parsed JSON so amounts can be read
 * from their digits (see plaid.ts). The client id and secret are the install's
 * own: each self-hoster signs up with Plaid and puts theirs in `.env`.
 */

import { PlaidDataError, parseJsonKeepingNumbers, parseSyncResponse, type SyncPage } from './plaid.ts';

export type PlaidEnvironment = 'sandbox' | 'production';

const BASE_URL: Record<PlaidEnvironment, string> = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

export class PlaidApiError extends Error {
  readonly code: string;
  readonly type: string;
  readonly status: number;
  readonly requestId: string | undefined;

  constructor(details: { code: string; type: string; status: number; message: string; requestId?: string }) {
    super(`${details.code}: ${details.message}`);
    this.code = details.code;
    this.type = details.type;
    this.status = details.status;
    this.requestId = details.requestId;
  }
}

/** Posts a request and returns the response body as text. */
export type PlaidCall = (path: string, body: Record<string, unknown>) => Promise<string>;

export type PlaidConfig = {
  clientId: string;
  secret: string;
  environment: PlaidEnvironment;
};

/** Reads PLAID_CLIENT_ID, PLAID_SECRET and PLAID_ENV, or says which is missing. */
export function plaidConfigFromEnv(env: Record<string, string | undefined> = process.env): PlaidConfig {
  const clientId = env.PLAID_CLIENT_ID;
  const secret = env.PLAID_SECRET;
  const environment = env.PLAID_ENV ?? 'sandbox';
  if (!clientId || !secret) {
    throw new Error('PLAID_CLIENT_ID and PLAID_SECRET must be set; see .env.example');
  }
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new Error(`PLAID_ENV is ${environment}; it must be sandbox or production`);
  }
  return { clientId, secret, environment };
}

export function plaidCall(config: PlaidConfig, fetchImpl: typeof fetch = fetch): PlaidCall {
  return async (path, body) => {
    const response = await fetchImpl(BASE_URL[config.environment] + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: config.clientId, secret: config.secret, ...body }),
    });
    const text = await response.text();
    if (response.ok) return text;

    // Plaid's error codes, not HTTP statuses, say what went wrong.
    let error: Record<string, unknown> = {};
    try {
      error = parseJsonKeepingNumbers(text) as Record<string, unknown>;
    } catch {
      // Not JSON - a proxy's error page, say. The status is all there is.
    }
    throw new PlaidApiError({
      code: typeof error.error_code === 'string' ? error.error_code : `HTTP_${response.status}`,
      type: typeof error.error_type === 'string' ? error.error_type : 'UNKNOWN',
      status: response.status,
      message: typeof error.error_message === 'string' ? error.error_message : text.slice(0, 200),
      ...(typeof error.request_id === 'string' ? { requestId: error.request_id } : {}),
    });
  };
}

export type SyncResult = Omit<SyncPage, 'nextCursor' | 'hasMore'> & {
  /** Where the next sync starts. Stored only once these changes are applied. */
  cursor: string;
};

/** How many times an update that changed while it was being paged is started again. */
const PAGINATION_RESTARTS = 3;

/**
 * Every change since `cursor`, all pages of it. Without a cursor, the whole
 * history Plaid holds. With `accountId`, that account's alone, under a cursor
 * of its own.
 *
 * If Plaid's data changes between pages it refuses the next one, and the whole
 * update has to be fetched again from the first page's cursor - keeping the
 * pages already read would mix two versions of the same history.
 */
export async function syncTransactions(
  call: PlaidCall,
  accessToken: string,
  cursor?: string,
  options: { accountId?: string } = {},
): Promise<SyncResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await syncPages(call, accessToken, cursor, options.accountId);
    } catch (error) {
      const changedUnderneath =
        error instanceof PlaidApiError && error.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';
      if (!changedUnderneath || attempt >= PAGINATION_RESTARTS) throw error;
    }
  }
}

async function syncPages(
  call: PlaidCall,
  accessToken: string,
  start: string | undefined,
  accountId: string | undefined,
): Promise<SyncResult> {
  const result: SyncResult = { added: [], modified: [], removed: [], accounts: [], cursor: start ?? '' };
  let cursor = start;
  for (;;) {
    const page = parseSyncResponse(
      await call('/transactions/sync', {
        access_token: accessToken,
        ...(cursor ? { cursor } : {}),
        count: 500,
        options: { include_original_description: true, ...(accountId ? { account_id: accountId } : {}) },
      }),
    );
    result.added.push(...page.added);
    result.modified.push(...page.modified);
    result.removed.push(...page.removed);
    result.accounts = page.accounts;
    if (page.status) result.status = page.status;
    if (page.nextCursor === cursor && page.hasMore) {
      throw new PlaidDataError('Plaid said there was more but returned the same cursor');
    }
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  }
  result.cursor = cursor ?? '';
  return result;
}
