import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEME_COLORS, THEME_COOKIE, themeColorFor, themeCookie, themeFrom } from './theme.ts';

test('a cookie names a theme, and anything else follows the system', () => {
  assert.equal(themeFrom('light'), 'light');
  assert.equal(themeFrom('dark'), 'dark');
  assert.equal(themeFrom('system'), 'system');
  for (const value of [undefined, null, '', 'DARK', 'sepia', 'dark; Path=/']) {
    assert.equal(themeFrom(value), 'system', String(value));
  }
});

test("following the system gives the browser one colour per scheme", () => {
  assert.deepEqual(themeColorFor('system'), [
    { media: '(prefers-color-scheme: light)', color: THEME_COLORS.light },
    { media: '(prefers-color-scheme: dark)', color: THEME_COLORS.dark },
  ]);
});

test('a chosen theme gives one colour, whatever the system says', () => {
  assert.deepEqual(themeColorFor('dark'), [{ color: THEME_COLORS.dark }]);
  assert.deepEqual(themeColorFor('light'), [{ color: THEME_COLORS.light }]);
});

test('the cookie is site-wide and long-lived, and choosing the system clears it', () => {
  assert.equal(
    themeCookie('dark', true),
    `${THEME_COOKIE}=dark; Path=/; SameSite=Lax; Max-Age=34560000; Secure`,
  );
  assert.doesNotMatch(themeCookie('light', false), /Secure/, 'plain-HTTP dev cannot set a Secure cookie');
  assert.match(themeCookie('system', true), /Max-Age=0/);
});
