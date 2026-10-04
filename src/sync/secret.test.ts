import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { SecretKeyError, decryptSecret, encryptSecret, secretKeyFromEnv } from './secret.ts';

const key = randomBytes(32);

test('a token comes back as it went in, and is not stored readable', () => {
  const token = 'access-sandbox-1b2c3d4e';
  const stored = encryptSecret(token, key);
  assert.ok(!stored.includes(token));
  assert.match(stored, /^v1\./);
  assert.equal(decryptSecret(stored, key), token);
});

test('the same token encrypts differently each time', () => {
  assert.notEqual(encryptSecret('t', key), encryptSecret('t', key));
});

test('the wrong key, or a stored value that was altered, is refused rather than misread', () => {
  const stored = encryptSecret('access-sandbox-1', key);
  assert.throws(() => decryptSecret(stored, randomBytes(32)), /could not be decrypted/);

  const parts = stored.split('.');
  const altered = Buffer.from(parts[3]!, 'base64url');
  altered[0] = altered[0]! ^ 1;
  parts[3] = altered.toString('base64url');
  assert.throws(() => decryptSecret(parts.join('.'), key), SecretKeyError);
});

test('the key must be set, and be 32 bytes', () => {
  assert.throws(() => secretKeyFromEnv({}), /openssl rand -base64 32/);
  assert.throws(() => secretKeyFromEnv({ MANILLA_SECRET_KEY: randomBytes(16).toString('base64') }), /16 bytes/);
  assert.equal(secretKeyFromEnv({ MANILLA_SECRET_KEY: key.toString('base64') }).length, 32);
});
