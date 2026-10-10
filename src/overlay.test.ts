import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closingChanges, openingChanges, overlayUrl } from './overlay.ts';

test('opening an overlay keeps every param that was already there', () => {
  assert.equal(
    overlayUrl('/transactions', 'account=a1&q=shell', openingChanges('txn', 't9')),
    '/transactions?account=a1&q=shell&txn=t9',
  );
});

test('what travels with an overlay goes in with it', () => {
  assert.equal(
    overlayUrl('/', '', openingChanges('on', 'move', { envelope: 'e2' })),
    '/?on=move&envelope=e2',
  );
});

test('opening one that is already open changes it rather than adding a second', () => {
  assert.equal(overlayUrl('/', 'on=fund&x=1', openingChanges('on', 'move')), '/?on=move&x=1');
});

test("opening it again without what travelled with it drops that, and only that", () => {
  assert.equal(
    overlayUrl('/review', 'pick=t1&to=account&q=x', openingChanges('pick', 't1', {}, ['to'])),
    '/review?pick=t1&q=x',
  );
  assert.equal(
    overlayUrl('/review', 'pick=t1&to=account', openingChanges('pick', 't1', { to: 'split' }, ['to'])),
    '/review?pick=t1&to=split',
  );
});

test('closing takes the overlay and what came with it, and nothing else', () => {
  assert.equal(
    overlayUrl('/', 'on=move&envelope=e2&view=edit', closingChanges('on', ['envelope'])),
    '/?view=edit',
  );
});

test('closing the last param leaves the bare path, not a dangling "?"', () => {
  assert.equal(overlayUrl('/review', 'pick=t1', closingChanges('pick', ['to'])), '/review');
});

test('values are encoded, so a param cannot smuggle in another', () => {
  const url = overlayUrl('/search', '', openingChanges('txn', 'a&b=c'));
  assert.equal(url, '/search?txn=a%26b%3Dc');
  assert.equal(new URL(url, 'http://x').searchParams.get('txn'), 'a&b=c');
});
