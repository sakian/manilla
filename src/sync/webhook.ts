/**
 * Plaid's webhooks (FR-16): Plaid saying it has fetched something from a bank,
 * so the sync goes then rather than up to a day later.
 *
 * The route that receives them (app/api/plaid/webhook/route.ts) is open to the
 * internet - Plaid has no session and no fixed address - so nothing in a
 * request is believed until its signature is. Plaid signs each one with a key
 * only it holds, over a hash of the body and the time it was sent. Even a
 * genuine one can do no more than the Sync button: a replay within the five
 * minutes it is accepted costs one more sync of a bank that is already synced.
 *
 * The hourly check stays (schedule.ts). Plaid does not promise delivery, and a
 * webhook that never arrived should cost a day's delay, not a feed gone quiet.
 */

import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { and, eq, isNotNull, isNull, ne, or } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { bankConnections } from '../../db/schema.ts';
import { PlaidApiError, type PlaidCall } from './plaidClient.ts';
import { decryptSecret } from './secret.ts';

/** Plaid's own limit on how old a webhook may be when it is checked. */
const MAX_AGE_SECONDS = 5 * 60;

/**
 * Where Plaid should send webhooks, from PLAID_WEBHOOK_URL, or null when that
 * is unset or not https - Plaid will not post to plain http, and nothing else
 * reaches a tailnet-only install from outside. Set only when the address is
 * reachable from the internet, which on the Tailscale deployment means Funnel.
 */
export function webhookUrlFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.PLAID_WEBHOOK_URL?.trim();
  if (!value) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

export type PlaidWebhook = { type: string; code: string; itemId: string; errorCode?: string };

/** The parts of a webhook Manilla acts on, or null for a body that is not one. */
export function parseWebhook(body: string): PlaidWebhook | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const hook = parsed as Record<string, unknown>;
  if (typeof hook.webhook_type !== 'string' || typeof hook.webhook_code !== 'string') return null;
  if (typeof hook.item_id !== 'string') return null;
  const error = hook.error as { error_code?: unknown } | null | undefined;
  return {
    type: hook.webhook_type,
    code: hook.webhook_code,
    itemId: hook.item_id,
    ...(typeof error?.error_code === 'string' ? { errorCode: error.error_code } : {}),
  };
}

/**
 * Whether a webhook is worth a sync.
 *
 * New or changed transactions, obviously. And a login that has stopped
 * working: the sync is what records that and tells the phones to sign in
 * again, which is otherwise found out at the next daily sync. The rest of what
 * Plaid sends - new accounts, consent expiring - is said by the app elsewhere
 * or not at all, and is acknowledged and left.
 */
export function wantsSync(hook: PlaidWebhook): boolean {
  if (hook.type === 'TRANSACTIONS') return hook.code === 'SYNC_UPDATES_AVAILABLE';
  return hook.type === 'ITEM' && hook.code === 'ERROR';
}

/** Plaid's public key for a key id, as /webhook_verification_key/get gives it, or null for none. */
export type KeySource = (keyId: string) => Promise<PlaidKey | null>;

export type PlaidKey = { kty: string; crv: string; x: string; y: string; expired_at?: number | null };

export type Verdict = { ok: true } | { ok: false; reason: string };

function decodePart(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Whether `body` is a webhook Plaid sent, by the JWT in its Plaid-Verification
 * header: signed ES256 by the key it names, issued in the last five minutes,
 * over this body exactly as it arrived.
 *
 * What can be checked without asking Plaid is checked first, so a request
 * someone made up costs nothing but this.
 */
export async function verifyWebhook(
  body: string,
  token: string | null,
  keyFor: KeySource,
  now: number = Date.now(),
): Promise<Verdict> {
  const parts = token?.split('.');
  if (!parts || parts.length !== 3) return { ok: false, reason: 'no Plaid-Verification token' };
  const [encodedHeader, encodedPayload, signature] = parts as [string, string, string];
  const header = decodePart(encodedHeader);
  const payload = decodePart(encodedPayload);
  if (!header || !payload) return { ok: false, reason: 'the token could not be read' };
  // Named outright: a token that chooses its own algorithm can choose "none".
  if (header.alg !== 'ES256') return { ok: false, reason: `the token is signed ${String(header.alg)}, not ES256` };
  if (typeof header.kid !== 'string' || header.kid === '') return { ok: false, reason: 'the token names no key' };

  const issued = payload.iat;
  if (typeof issued !== 'number' || Math.abs(now / 1000 - issued) > MAX_AGE_SECONDS) {
    return { ok: false, reason: 'the token is more than five minutes from now' };
  }
  const claimed = payload.request_body_sha256;
  const actual = createHash('sha256').update(body, 'utf8').digest('hex');
  if (
    typeof claimed !== 'string' ||
    claimed.length !== actual.length ||
    !timingSafeEqual(Buffer.from(claimed), Buffer.from(actual))
  ) {
    return { ok: false, reason: 'the body is not the one that was signed' };
  }

  const key = await keyFor(header.kid);
  if (!key) return { ok: false, reason: `Plaid has no key ${header.kid}` };
  if (key.expired_at != null) return { ok: false, reason: `key ${header.kid} has expired` };
  let publicKey;
  try {
    publicKey = createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x, y: key.y }, format: 'jwk' });
  } catch {
    return { ok: false, reason: `key ${header.kid} could not be read` };
  }
  const signed = verify(
    'sha256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    // A JWT's ES256 signature is r and s side by side, not DER.
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'),
  );
  return signed ? { ok: true } : { ok: false, reason: 'the signature does not match' };
}

/** A key is looked up again after this, to notice Plaid expiring it. */
const KEY_KEPT_MS = 24 * 60 * 60 * 1000;

/**
 * Plaid's verification keys, asked for by id and remembered.
 *
 * Plaid rotates them rarely, so almost every webhook is checked against a key
 * already held. A key id Plaid has never heard of is remembered as such, and
 * only so many new ids are looked up an hour: the token naming the key is
 * unverified until the key is fetched, and an open route that made a Plaid call
 * for every id anyone cared to invent would spend Plaid's rate limit on them.
 */
export function plaidKeys(
  call: PlaidCall,
  options: { lookupsPerHour?: number; now?: () => number } = {},
): KeySource {
  const perHour = options.lookupsPerHour ?? 10;
  const now = options.now ?? Date.now;
  const known = new Map<string, { key: PlaidKey | null; at: number }>();
  let lookups: number[] = [];

  return async (keyId) => {
    const held = known.get(keyId);
    if (held && now() - held.at < KEY_KEPT_MS) return held.key;

    lookups = lookups.filter((at) => now() - at < 60 * 60 * 1000);
    if (lookups.length >= perHour) return held?.key ?? null;
    lookups.push(now());

    let key: PlaidKey | null;
    try {
      const response = JSON.parse(await call('/webhook_verification_key/get', { key_id: keyId })) as {
        key?: PlaidKey;
      };
      key = response.key ?? null;
    } catch (error) {
      if (!(error instanceof PlaidApiError && error.code === 'INVALID_WEBHOOK_VERIFICATION_KEY_ID')) throw error;
      key = null;
    }
    known.set(keyId, { key, at: now() });
    return key;
  };
}

/**
 * One bank login's copies in a ledger that a webhook should sync: every live
 * one. Not one waiting for its login - only a person signing in again fixes
 * that, and syncing it again would only say so again.
 */
export function liveCopiesOf(itemId: string): (db: Database) => Promise<string[]> {
  return async (db) => {
    const rows = await db
      .select({ id: bankConnections.id })
      .from(bankConnections)
      .where(
        and(
          eq(bankConnections.itemId, itemId),
          isNull(bankConnections.revokedAt),
          isNotNull(bankConnections.accessToken),
          or(isNull(bankConnections.errorCode), ne(bankConnections.errorCode, 'ITEM_LOGIN_REQUIRED')),
        ),
      );
    return rows.map((row) => row.id);
  };
}

/**
 * Point every live bank login's webhooks at `url`. A link made from now on is
 * told when it is made (createLinkToken); this is for the ones made before the
 * address was set, or under another one. Each login once, however many ledgers
 * hold a copy, and only when Plaid has something else.
 */
export async function registerWebhooks(
  ledgers: Database[],
  url: string,
  deps: { call: PlaidCall; key: Buffer },
  log: (line: string) => void,
): Promise<{ updated: number; failed: number }> {
  const seen = new Set<string>();
  let updated = 0;
  let failed = 0;
  for (const db of ledgers) {
    const rows = await db
      .select({ itemId: bankConnections.itemId, accessToken: bankConnections.accessToken })
      .from(bankConnections)
      .where(and(isNull(bankConnections.revokedAt), isNotNull(bankConnections.accessToken)));
    for (const row of rows) {
      if (seen.has(row.itemId)) continue;
      seen.add(row.itemId);
      try {
        const accessToken = decryptSecret(row.accessToken!, deps.key);
        const found = JSON.parse(await deps.call('/item/get', { access_token: accessToken })) as {
          item?: { webhook?: string | null };
        };
        if (found.item?.webhook === url) continue;
        await deps.call('/item/webhook/update', { access_token: accessToken, webhook: url });
        updated++;
      } catch (error) {
        // One login Plaid will not talk about - revoked at the bank, say - is
        // no reason to leave the rest unregistered.
        failed++;
        log(`could not set the webhook for a bank login: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { updated, failed };
}
