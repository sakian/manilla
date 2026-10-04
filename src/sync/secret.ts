/**
 * Encrypting a bank feed's access token at rest (FR-20).
 *
 * The token reaches the bank as the person who linked it, for as long as the
 * aggregator keeps it alive. Encrypting it with a key that lives in `.env`, not
 * the database, means a database backup or a copied volume alone holds nothing
 * that reaches the bank; the two have to be taken together.
 *
 * AES-256-GCM, so a token that has been tampered with fails to decrypt rather
 * than decrypting to something else. Stored as `v1.<iv>.<tag>.<ciphertext>`,
 * base64url, so a different scheme later can sit beside this one.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class SecretKeyError extends Error {}

/** The key from MANILLA_SECRET_KEY: 32 random bytes, base64. */
export function secretKeyFromEnv(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env.MANILLA_SECRET_KEY;
  if (!raw) {
    throw new SecretKeyError(
      'MANILLA_SECRET_KEY is not set, so a bank token cannot be stored. ' +
        'Generate one with: openssl rand -base64 32',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new SecretKeyError(`MANILLA_SECRET_KEY is ${key.length} bytes; it must be 32 (openssl rand -base64 32)`);
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ciphertext].map((part) =>
    typeof part === 'string' ? part : part.toString('base64url'),
  ).join('.');
}

export function decryptSecret(stored: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = stored.split('.');
  if (version !== 'v1' || !iv || !tag || ciphertext === undefined) {
    throw new SecretKeyError('A stored token is not in a form this version can read');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Wrong key, or the stored value was altered. Either way the token is gone.
    throw new SecretKeyError(
      'A stored bank token could not be decrypted. MANILLA_SECRET_KEY may have changed; ' +
        'the connection has to be linked again.',
    );
  }
}
