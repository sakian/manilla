import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_SIZE, readForm, readPage, readQuery, withParams, writeQuery } from './urlQuery.ts';

/**
 * The URL is the search (VW-5, VW-6), so this module is what every transaction
 * list actually runs. It had no tests until now for a structural reason: it
 * lived under `app/`, and the test runner only ever looked at `src/`. A redirect
 * that dropped every filter on a saved link survived a release that way.
 */
describe('filters in the URL', () => {
  test('an empty query asks for the first page and nothing else', () => {
    const query = readQuery({});
    assert.deepEqual(query, { limit: PAGE_SIZE, offset: 0 });
  });

  test('text, payee and memo are separate filters', () => {
    const query = readQuery({ q: 'coffee', payee: 'TIM', memo: 'refund' });
    assert.equal(query.text, 'coffee');
    assert.equal(query.payee, 'TIM');
    assert.equal(query.memo, 'refund');
  });

  test('repeated params accumulate, single ones do not', () => {
    const query = readQuery({ env: ['a', 'b'], account: 'c' });
    assert.deepEqual(query.envelopeIds, ['a', 'b']);
    assert.deepEqual(query.accountIds, ['c']);
  });

  test('amounts are dollars in the URL and cents inside (NF-1)', () => {
    const query = readQuery({ min: '50', max: '1234.56' });
    assert.equal(query.minCents, 5000);
    assert.equal(query.maxCents, 123456);
  });

  // A URL is typed and edited by hand, so a filter that cannot be read is
  // dropped rather than turned into an error page in place of the results.
  test('a value that makes no sense is dropped, not refused', () => {
    const query = readQuery({
      status: 'banana',
      kind: 'nonsense',
      dir: 'sideways',
      sort: 'whatever',
      order: 'up',
      from: '3 May',
      min: 'lots',
    });
    assert.deepEqual(query, { limit: PAGE_SIZE, offset: 0 });
  });

  test('paging is an offset, and page 0 is page 1', () => {
    assert.equal(readQuery({ page: '3' }).offset, PAGE_SIZE * 2);
    assert.equal(readQuery({ page: '0' }).offset, 0);
    assert.equal(readQuery({ page: '-4' }).offset, 0);
    assert.equal(readPage({ page: 'x' }), 1);
  });

  test('the page size is capped however the URL asks', () => {
    assert.ok((readQuery({}, { pageSize: 100_000 }).limit ?? Infinity) <= 10_000);
  });
});

describe('filters back into a URL', () => {
  test('empty fields are left out, so a shared link says only what it filters', () => {
    assert.equal(writeQuery({ q: 'coffee', payee: '', memo: '   ' }), 'q=coffee');
  });

  test('the defaults are not written down', () => {
    assert.equal(writeQuery({ sort: 'date', order: 'desc' }), '');
    assert.equal(writeQuery({ sort: 'amount' }), 'sort=amount');
  });

  test('what is written can be read back', () => {
    const values = {
      q: 'coffee',
      payee: 'TIM',
      memo: '',
      from: '2026-01-01',
      to: '2026-03-31',
      min: '5',
      max: '50',
      dir: 'out',
      status: 'confirmed',
      kind: 'spending',
      accounts: ['acc-1'],
      accountGroups: [],
      envelopes: ['env-1', 'env-2'],
      envelopeGroups: ['grp-1'],
      sort: 'amount',
      order: 'asc',
    };
    const params = Object.fromEntries(
      [...new URLSearchParams(writeQuery(values)).entries()].reduce((map, [key, value]) => {
        const seen = map.get(key);
        return map.set(key, seen === undefined ? value : [...[seen].flat(), value]);
      }, new Map<string, string | string[]>()),
    );

    assert.deepEqual(readForm(params), values);
  });
});

describe('a link to the same search somewhere else', () => {
  test('filters survive; the page resets unless asked for', () => {
    assert.equal(withParams('/transactions', { q: 'coffee', page: '4' }), '/transactions?q=coffee');
    assert.equal(withParams('/transactions', { q: 'coffee' }, 3), '/transactions?q=coffee&page=3');
  });

  // Which dialog is open has no business in a link to the next page, or in the
  // CSV of what is on screen.
  test('an open dialog is not part of the search', () => {
    const link = withParams('/transactions', { q: 'coffee', txn: 'abc', pick: 'env', to: 'x' });
    assert.equal(link, '/transactions?q=coffee');
  });

  // A filter added later, or typed by hand, rides along rather than being
  // silently dropped - which is the failure this whole file exists for.
  test('a param this module has never heard of still survives', () => {
    assert.match(withParams('/transactions', { future: 'yes' }), /future=yes/);
  });

  test('no filters means no question mark', () => {
    assert.equal(withParams('/transactions', {}), '/transactions');
    assert.equal(withParams('/transactions', { q: '   ' }), '/transactions');
  });

  test('a saved /search link keeps every filter it was carrying', () => {
    // Exactly what app/search/page.tsx does with the params it is handed.
    const saved = { q: 'coffee', env: ['env-1', 'env-2'], min: '5', status: 'confirmed' };
    const landed = withParams('/transactions', saved);

    assert.match(landed, /^\/transactions\?/);
    assert.deepEqual(readQuery(Object.fromEntries(groupParams(landed))), {
      text: 'coffee',
      envelopeIds: ['env-1', 'env-2'],
      minCents: 500,
      status: 'confirmed',
      limit: PAGE_SIZE,
      offset: 0,
    });
  });
});

/** `?a=1&a=2` back into the shape Next hands a page. */
function groupParams(url: string): Map<string, string | string[]> {
  const search = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  const out = new Map<string, string | string[]>();
  for (const [key, value] of search) {
    const seen = out.get(key);
    out.set(key, seen === undefined ? value : [...[seen].flat(), value]);
  }
  return out;
}
