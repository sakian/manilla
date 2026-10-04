import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diskUsedShare } from './disk.ts';

test("the disk's share in use is read as a fraction, and an unreadable path is null", async () => {
  const share = await diskUsedShare('/');
  assert.ok(share !== null && share > 0 && share < 1, `read ${share}`);
  assert.equal(await diskUsedShare('/no/such/path/here'), null);
});
