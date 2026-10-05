/**
 * Where Plaid says it has fetched something from a bank (FR-16).
 *
 * Open to the internet, with no session: Plaid has none, and it posts over
 * Funnel. What stands in for sign-in is Plaid's signature (src/sync/webhook.ts),
 * checked before anything in the body is read, and what a verified webhook can
 * start is a sync - the Sync button's work, run as "Plaid webhook" in the audit
 * trail - with nothing in the body chosen by its sender beyond which bank.
 *
 * Not there at all until PLAID_WEBHOOK_URL is set: an install that has not
 * asked Plaid for webhooks has no reason to answer for them.
 */

import { after } from 'next/server';
import { runAs } from '../../../../src/audit/actor.ts';
import { plaidCall, plaidConfigFromEnv } from '../../../../src/sync/plaidClient.ts';
import { syncAndTell } from '../../../../src/sync/schedule.ts';
import { secretKeyFromEnv } from '../../../../src/sync/secret.ts';
import {
  liveCopiesOf,
  parseWebhook,
  plaidKeys,
  verifyWebhook,
  wantsSync,
  webhookUrlFromEnv,
  type KeySource,
} from '../../../../src/sync/webhook.ts';

export const dynamic = 'force-dynamic';

/** Plaid's webhooks are a few hundred bytes; anything near this is not one. */
const MAX_BODY = 64 * 1024;

const log = (line: string) => console.log(`[manilla] ${line}`);

/** Kept between requests, so a key is fetched from Plaid once rather than per webhook. */
let keys: KeySource | undefined;

export async function POST(request: Request) {
  if (!webhookUrlFromEnv()) return new Response('Not found', { status: 404 });
  let deps;
  try {
    deps = { call: plaidCall(plaidConfigFromEnv()), key: secretKeyFromEnv() };
  } catch {
    return new Response('Not found', { status: 404 });
  }

  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) {
    return new Response('Too large', { status: 413 });
  }
  const body = await request.text();
  if (body.length > MAX_BODY) return new Response('Too large', { status: 413 });

  keys ??= plaidKeys(deps.call);
  let verdict;
  try {
    verdict = await verifyWebhook(body, request.headers.get('plaid-verification'), keys);
  } catch (error) {
    // Plaid's key service did not answer. A failure status makes Plaid try the
    // webhook again later; the daily sync is there if it never gets through.
    log(`a Plaid webhook could not be checked: ${error instanceof Error ? error.message : String(error)}`);
    return new Response('Try again', { status: 503 });
  }
  if (!verdict.ok) {
    log(`refused a webhook claiming to be Plaid's: ${verdict.reason}`);
    return new Response('Not verified', { status: 401 });
  }

  const hook = parseWebhook(body);
  if (hook && wantsSync(hook)) {
    // Plaid wants its answer within seconds and a sync can take longer, so it
    // is answered first and synced after.
    after(() =>
      runAs({ id: null, name: 'Plaid webhook' }, () => syncAndTell(liveCopiesOf(hook.itemId), deps, log)),
    );
  }
  return new Response(null, { status: 204 });
}
