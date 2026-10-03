import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readVersion } from './version.ts';

describe('the version this install is running (#20)', () => {
  test('a build from git says its commit, the day it was made, and whether it was changed', () => {
    assert.deepEqual(
      readVersion({ MANILLA_COMMIT: 'a07bfce', MANILLA_COMMITTED: '2026-10-03', MANILLA_MODIFIED: '1' }),
      { commit: 'a07bfce', committed: '2026-10-03', modified: true },
    );
    assert.equal(readVersion({ MANILLA_COMMIT: 'a07bfce' })!.modified, false);
  });

  test('a build with no git to ask has no version, rather than a made-up one', () => {
    assert.equal(readVersion({}), null);
    assert.equal(readVersion({ MANILLA_COMMIT: '  ' }), null);
  });

  test('a date that is not a calendar date is left out, not shown', () => {
    assert.equal(readVersion({ MANILLA_COMMIT: 'a07bfce', MANILLA_COMMITTED: 'yesterday' })!.committed, null);
  });
});
