/**
 * Every server action says who is acting, so the audit trail can (NF-2).
 *
 * The rule lives in app/, which the test runner cannot load (issue #16), so
 * this reads the source instead: an action that checks the session without
 * `actAs` would write changes the trail can only call "not recorded who".
 * Sign-in is the exception - nobody is signed in yet, and it writes no money.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const APP = join(import.meta.dirname, '..', '..', 'app');
const EXEMPT = new Set(['login/actions.ts']);

function serverActionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return serverActionFiles(path);
    if (!/\.tsx?$/.test(entry.name)) return [];
    return /^['"]use server['"]/m.test(readFileSync(path, 'utf8')) ? [path] : [];
  });
}

test('there are server actions to check', () => {
  assert.ok(serverActionFiles(APP).length >= 5);
});

for (const file of serverActionFiles(APP)) {
  const name = relative(APP, file);
  if (EXEMPT.has(name)) continue;

  test(`${name}: every session check also says who is acting`, () => {
    const source = readFileSync(file, 'utf8');
    const checks = source.match(/await requireUser\(\)/g)?.length ?? 0;
    const claimed = source.match(/actAs\(await requireUser\(\)\)/g)?.length ?? 0;
    const actions = source.match(/^export async function /gm)?.length ?? 0;
    assert.equal(claimed, checks, 'write `actAs(await requireUser())`, not a bare check');
    assert.ok(checks >= actions, 'and every exported action checks the session');
  });
}
