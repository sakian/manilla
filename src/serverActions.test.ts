/**
 * Every server action is a POST endpoint reachable without the page that
 * renders its button, so each one has to check the session itself. That used to
 * be verified by reading them (#16); this reads them instead.
 *
 * It is a scan of the source rather than a call, because an action needs Next's
 * request context to run and app/ is presentation the runner does not load. The
 * shape it checks is the house style: `'use server'` at the top of a file of
 * actions, each starting `await requireUser()`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const app = join(root, 'app');

/** Signing in cannot require being signed in; each one there says why it is safe. */
const PUBLIC = new Set(['app/login/actions.ts']);

const sources = readdirSync(app, { recursive: true, encoding: 'utf8' })
  .filter((path) => /\.tsx?$/.test(path))
  .map((path) => ({ path: relative(root, join(app, path)), text: readFileSync(join(app, path), 'utf8') }));

const actionFiles = sources.filter(({ text }) => /['"]use server['"]/.test(text));

test('there are server actions to check', () => {
  assert.ok(actionFiles.length >= 5, 'the scan found the action files');
});

test("'use server' only ever marks a whole file", () => {
  // An action declared inline in a component would escape the check below.
  for (const { path, text } of actionFiles) {
    const first = text.replace(/^\s*(\/\/.*\n|\/\*[\s\S]*?\*\/\s*)*/, '').trimStart();
    assert.match(first, /^['"]use server['"];/, `${path}: 'use server' must open the file`);
  }
});

test('every server action outside sign-in checks the session first', () => {
  const checked: string[] = [];
  for (const { path, text } of actionFiles) {
    if (PUBLIC.has(path)) continue;
    for (const match of text.matchAll(/^export async function (\w+)\(/gm)) {
      const end = text.indexOf('\n}\n', match.index);
      const body = text.slice(match.index, end === -1 ? undefined : end);
      assert.match(body, /await requireUser\(\)/, `${path}: ${match[1]} does not call requireUser()`);
      checked.push(match[1]!);
    }
    assert.doesNotMatch(
      text,
      /^export (const|let|default)/m,
      `${path}: an action exported some other way would escape this check`,
    );
  }
  assert.ok(checked.length >= 50, `checked ${checked.length} actions`);
});
