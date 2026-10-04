import { test } from 'node:test';
import assert from 'node:assert/strict';
import { securityHeaders } from './security-headers.ts';

function byKey(production: boolean): Map<string, string> {
  return new Map(securityHeaders(production).map(({ key, value }) => [key, value]));
}

test('nobody else can frame the app', () => {
  const headers = byKey(true);
  assert.match(headers.get('Content-Security-Policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(headers.get('X-Frame-Options'), 'DENY');
});

test('the CSP leaves scripts alone rather than half-restricting them', () => {
  assert.doesNotMatch(byKey(true).get('Content-Security-Policy') ?? '', /script-src|default-src/);
});

test('passkeys are not switched off by the permissions policy', () => {
  assert.doesNotMatch(byKey(true).get('Permissions-Policy') ?? '', /publickey-credentials/);
});

test('HSTS only in production', () => {
  assert.equal(byKey(true).get('Strict-Transport-Security'), 'max-age=31536000');
  assert.equal(byKey(false).has('Strict-Transport-Security'), false);
});

test('each header appears once', () => {
  const keys = securityHeaders(true).map(({ key }) => key.toLowerCase());
  assert.equal(new Set(keys).size, keys.length);
});
