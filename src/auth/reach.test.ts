import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstSetupGate, recoveryAllowed, requestReach } from './reach.ts';

const headers = (values: Record<string, string>) => new Headers(values);

test('a Funnel request is public, whatever else it carries', () => {
  assert.equal(requestReach(headers({ 'Tailscale-Funnel-Request': '?1' })), 'funnel');
  assert.equal(
    requestReach(headers({ 'Tailscale-Funnel-Request': '?1', 'Tailscale-User-Login': 'a@b.c' })),
    'funnel',
  );
});

test('a tailnet user is named by tailscale serve', () => {
  assert.equal(requestReach(headers({ 'Tailscale-User-Login': 'someone@example.com' })), 'tailnet');
});

test('no Tailscale headers, or an empty login, is unknown', () => {
  assert.equal(requestReach(headers({})), 'unknown');
  assert.equal(requestReach(headers({ 'Tailscale-User-Login': '' })), 'unknown');
  assert.equal(requestReach(headers({ 'X-Forwarded-For': '203.0.113.9' })), 'unknown');
});

test('in development anyone may set up, because localhost is the only way in', () => {
  for (const reach of ['tailnet', 'funnel', 'unknown'] as const) {
    assert.deepEqual(firstSetupGate(reach, {}, false), { allowed: true });
  }
});

test('in production a tailnet user may set up', () => {
  assert.deepEqual(firstSetupGate('tailnet', {}, true), { allowed: true });
});

test('in production the public internet may not, even with the override', () => {
  assert.equal(firstSetupGate('funnel', {}, true).allowed, false);
  assert.equal(firstSetupGate('funnel', { MANILLA_ALLOW_SETUP: '1' }, true).allowed, false);
});

test('in production an unknown sender needs MANILLA_ALLOW_SETUP=1 exactly', () => {
  assert.equal(firstSetupGate('unknown', {}, true).allowed, false);
  assert.equal(firstSetupGate('unknown', { MANILLA_ALLOW_SETUP: 'true' }, true).allowed, false);
  assert.equal(firstSetupGate('unknown', { MANILLA_ALLOW_SETUP: '0' }, true).allowed, false);
  assert.deepEqual(firstSetupGate('unknown', { MANILLA_ALLOW_SETUP: ' 1 ' }, true), {
    allowed: true,
  });
});

test('production follows NODE_ENV when not given', () => {
  assert.equal(firstSetupGate('unknown', { NODE_ENV: 'production' }).allowed, false);
  assert.equal(firstSetupGate('unknown', { NODE_ENV: 'development' }).allowed, true);
});

test('a refusal says what to do about it', () => {
  const gate = firstSetupGate('unknown', {}, true);
  assert.ok(!gate.allowed && gate.reason.includes('MANILLA_ALLOW_SETUP=1'));
});

test('recovery codes are refused over Funnel and nowhere else', () => {
  assert.equal(recoveryAllowed('funnel'), false);
  assert.equal(recoveryAllowed('tailnet'), true);
  assert.equal(recoveryAllowed('unknown'), true, 'behind Nginx there is no telling');
});
