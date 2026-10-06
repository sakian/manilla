import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openInLedger, safePath } from './safePath.ts';

test('a path on this site is kept as it is', () => {
  assert.equal(safePath('/review?view=mine'), '/review?view=mine');
  assert.equal(safePath('/transactions?account=abc#top'), '/transactions?account=abc#top');
  assert.equal(safePath(['/settings/you', '/other']), '/settings/you');
});

test('anything that could leave the site becomes the home screen', () => {
  for (const value of [
    '//evil.example',
    '/\\evil.example',
    '/\\/evil.example',
    'https://evil.example/review',
    'javascript:alert(1)',
    'review',
    '',
    null,
    undefined,
  ]) {
    assert.equal(safePath(value), '/', String(value));
  }
});

test('a link into a ledger carries the ledger and the page, encoded', () => {
  const link = openInLedger('manilla_ledger_opifex', '/review?view=mine');
  assert.equal(link, '/open?ledger=manilla_ledger_opifex&to=%2Freview%3Fview%3Dmine');
  const params = new URL(link, 'http://x').searchParams;
  assert.equal(params.get('ledger'), 'manilla_ledger_opifex');
  assert.equal(safePath(params.get('to')), '/review?view=mine');
});
