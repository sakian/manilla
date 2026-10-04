import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PlaidDataError, parseSyncResponse, planChanges } from './plaid.ts';
import { page, transaction } from './plaidFixtures.ts';
import {
  PlaidApiError,
  plaidCall,
  plaidConfigFromEnv,
  syncTransactions,
  type PlaidCall,
} from './plaidClient.ts';

/** Plaid's own example response for /transactions/sync, from its OpenAPI description. */
const documented = readFileSync(new URL('../../data/samples/plaid-sync.json', import.meta.url), 'utf8');

describe('reading a sync response', () => {
  test("Plaid's documented example", () => {
    const parsed = parseSyncResponse(documented);

    assert.deepEqual(parsed.added, [
      {
        id: 'lPNjeW1nR6CDn5okmGQ6hEpMo4lLNoSrzqDje',
        accountId: 'BxBXxLj1m4HMXBm9WZZmCWVbPjX16EHwv99vp',
        date: '2023-09-24',
        authorizedDate: '2023-09-22',
        amountCents: -7210,
        currency: 'USD',
        description: 'PURCHASE WM SUPERCENTER #1700',
        merchantName: 'Walmart',
        pending: false,
        pendingId: 'no86Eox18VHMvaOVL7gPUM9ap3aR1LsAVZ5nc',
        warnings: [],
      },
    ]);
    assert.equal(parsed.modified[0]!.amountCents, -2834);
    assert.equal(parsed.modified[0]!.pending, true);
    assert.equal(parsed.modified[0]!.pendingId, undefined);
    assert.deepEqual(parsed.removed, [
      { id: 'CmdQTNgems8BT1B7ibkoUXVPyAeehT3Tmzk0l', accountId: 'BxBXxLj1m4HMXBm9WZZmCWVbPjX16EHwv99vp' },
    ]);
    assert.deepEqual(parsed.accounts, [
      {
        id: 'BxBXxLj1m4HMXBm9WZZmCWVbPjX16EHwv99vp',
        name: 'Plaid Checking',
        mask: '0000',
        type: 'depository',
        subtype: 'checking',
        currentCents: 11094,
        availableCents: 11094,
        currency: 'USD',
        warnings: [],
      },
    ]);
    assert.equal(parsed.hasMore, false);
    assert.equal(parsed.status, 'HISTORICAL_UPDATE_COMPLETE');
  });

  test('money out is negative and money in positive, the other way round from Plaid', () => {
    const parsed = parseSyncResponse(
      page({
        added: [
          transaction({ transaction_id: 'out', amount: '45.20' }),
          transaction({ transaction_id: 'in', amount: '-1500' }),
        ],
      }),
    );
    assert.deepEqual(
      parsed.added.map((t) => t.amountCents),
      [-4520, 150000],
    );
  });

  test('cents come from the digits, not from a float', () => {
    // 1234.56 * 100 in floating point is 123455.99999999999.
    const parsed = parseSyncResponse(page({ added: [transaction({ amount: '1234.56' })] }));
    assert.equal(parsed.added[0]!.amountCents, -123456);
  });

  test('more than two decimals is rounded half-up, and says so on the transaction', () => {
    // The sandbox sends amounts like these; a real bank should not, so it shows.
    const cases: [string, number, string][] = [
      ['12.202726', -1220, 'The amount was 12.202726; rounded to 12.20'],
      ['12.345', -1235, 'The amount was 12.345; rounded to 12.35'],
      ['-28.340000000000003', 2834, 'The amount was 28.340000000000003; rounded to 28.34'],
    ];
    for (const [amount, cents, warning] of cases) {
      const [parsed] = parseSyncResponse(page({ added: [transaction({ amount })] })).added;
      assert.equal(parsed!.amountCents, cents, amount);
      assert.deepEqual(parsed!.warnings, [warning], amount);
    }
  });

  test('an amount with an exponent is refused, not guessed', () => {
    assert.throws(
      () => parseSyncResponse(page({ added: [transaction({ amount: '1e3' })] })),
      (error: unknown) => error instanceof PlaidDataError && /not a plain decimal/.test(error.message),
    );
  });

  test("the bank's own description is preferred to Plaid's cleaned-up one", () => {
    const parsed = parseSyncResponse(
      page({
        added: [transaction({ amount: '4.50', name: 'Coffee Shop', original_description: 'COFFEE SHOP #12 TORONTO ON' })],
      }),
    );
    assert.equal(parsed.added[0]!.description, 'COFFEE SHOP #12 TORONTO ON');
  });

  test('a date that is an instant rather than a calendar day is refused', () => {
    assert.throws(
      () => parseSyncResponse(page({ added: [transaction({ amount: '1.00', date: '2026-09-03T05:00:00Z' })] })),
      /not a YYYY-MM-DD date/,
    );
  });
});

describe('planning the changes', () => {
  const pending = {
    id: 'p1',
    accountId: 'a',
    date: '2026-09-01',
    amountCents: -2000,
    description: 'GAS',
    pending: true,
    warnings: [],
  };
  const posted = { ...pending, id: 'c1', date: '2026-09-03', amountCents: -2150, pending: false, pendingId: 'p1' };

  test('a posting replaces its pending charge instead of adding beside it (FR-19)', () => {
    const plan = planChanges({ added: [posted], modified: [], removed: [{ id: 'p1', accountId: 'a' }] });
    assert.deepEqual(plan, [{ kind: 'post', transaction: posted, pendingId: 'p1' }]);
  });

  test('a pending charge that fell away is still removed', () => {
    const plan = planChanges({ added: [], modified: [], removed: [{ id: 'p9', accountId: 'a' }] });
    assert.deepEqual(plan, [{ kind: 'remove', id: 'p9', accountId: 'a' }]);
  });

  test('a posting whose pending charge never arrived is still a posting', () => {
    const plan = planChanges({ added: [posted], modified: [], removed: [] });
    assert.deepEqual(plan, [{ kind: 'post', transaction: posted, pendingId: 'p1' }]);
  });

  test('new pending charges are added, and changes keep their order', () => {
    const changed = { ...pending, id: 'p2', amountCents: -2500 };
    const plan = planChanges({ added: [pending], modified: [changed], removed: [{ id: 'p3', accountId: 'a' }] });
    assert.deepEqual(
      plan.map((change) => change.kind),
      ['add', 'update', 'remove'],
    );
  });
});

describe('syncing', () => {
  function fakePlaid(responses: (string | PlaidApiError)[]): { call: PlaidCall; cursors: (string | undefined)[] } {
    const cursors: (string | undefined)[] = [];
    const call: PlaidCall = async (path, body) => {
      assert.equal(path, '/transactions/sync');
      cursors.push(body.cursor as string | undefined);
      const next = responses.shift();
      if (next === undefined) throw new Error('No more responses');
      if (next instanceof PlaidApiError) throw next;
      return next;
    };
    return { call, cursors };
  }

  const mutation = new PlaidApiError({
    code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
    type: 'TRANSACTIONS_ERROR',
    status: 400,
    message: 'Underlying transaction data changed since last page was fetched',
  });

  test('pages are gathered and the last cursor kept', async () => {
    const { call, cursors } = fakePlaid([
      page({ added: [transaction({ transaction_id: 'a', amount: '1.00' })], next_cursor: 'c2', has_more: true }),
      page({ added: [transaction({ transaction_id: 'b', amount: '2.00' })], next_cursor: 'c3' }),
    ]);
    const result = await syncTransactions(call, 'token', 'c1');
    assert.deepEqual(cursors, ['c1', 'c2']);
    assert.deepEqual(
      result.added.map((t) => t.id),
      ['a', 'b'],
    );
    assert.equal(result.cursor, 'c3');
  });

  test('the first sync sends no cursor', async () => {
    const { call, cursors } = fakePlaid([page({ next_cursor: 'c1' })]);
    const result = await syncTransactions(call, 'token');
    assert.deepEqual(cursors, [undefined]);
    assert.equal(result.cursor, 'c1');
  });

  test('data that changes mid-way starts again from the first page, dropping what was read', async () => {
    const { call, cursors } = fakePlaid([
      page({ added: [transaction({ transaction_id: 'stale', amount: '1.00' })], next_cursor: 'c2', has_more: true }),
      mutation,
      page({ added: [transaction({ transaction_id: 'fresh', amount: '1.00' })], next_cursor: 'c9' }),
    ]);
    const result = await syncTransactions(call, 'token', 'c1');
    assert.deepEqual(cursors, ['c1', 'c2', 'c1']);
    assert.deepEqual(
      result.added.map((t) => t.id),
      ['fresh'],
    );
  });

  test('it gives up rather than loop forever', async () => {
    const { call } = fakePlaid([mutation, mutation, mutation, mutation]);
    await assert.rejects(syncTransactions(call, 'token', 'c1'), /MUTATION_DURING_PAGINATION/);
  });

  test('other errors are not retried', async () => {
    const login = new PlaidApiError({ code: 'ITEM_LOGIN_REQUIRED', type: 'ITEM_ERROR', status: 400, message: 'x' });
    const { call, cursors } = fakePlaid([login, page({})]);
    await assert.rejects(syncTransactions(call, 'token', 'c1'), /ITEM_LOGIN_REQUIRED/);
    assert.equal(cursors.length, 1);
  });
});

describe('the client', () => {
  const config = { clientId: 'id', secret: 'secret', environment: 'sandbox' as const };

  test("Plaid's error code is what the error carries", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          error_type: 'ITEM_ERROR',
          error_code: 'ITEM_LOGIN_REQUIRED',
          error_message: 'the login details of this item have changed',
          request_id: 'req-1',
        }),
        { status: 400 },
      )) as typeof fetch;
    await assert.rejects(plaidCall(config, fetchImpl)('/transactions/sync', {}), (error: unknown) => {
      assert.ok(error instanceof PlaidApiError);
      assert.equal(error.code, 'ITEM_LOGIN_REQUIRED');
      assert.equal(error.requestId, 'req-1');
      return true;
    });
  });

  test('credentials go in the body, to the chosen environment', async () => {
    let seen: { url: string; body: Record<string, unknown> } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(init.body as string) };
      return new Response('{}');
    }) as unknown as typeof fetch;
    await plaidCall(config, fetchImpl)('/item/remove', { access_token: 't' });
    assert.equal(seen?.url, 'https://sandbox.plaid.com/item/remove');
    assert.deepEqual(seen?.body, { client_id: 'id', secret: 'secret', access_token: 't' });
  });

  test('configuration defaults to the sandbox and refuses anything unknown', () => {
    assert.equal(plaidConfigFromEnv({ PLAID_CLIENT_ID: 'a', PLAID_SECRET: 'b' }).environment, 'sandbox');
    assert.throws(() => plaidConfigFromEnv({ PLAID_CLIENT_ID: 'a', PLAID_SECRET: 'b', PLAID_ENV: 'development' }), /sandbox or production/);
    assert.throws(() => plaidConfigFromEnv({}), /PLAID_CLIENT_ID/);
  });
});
