/**
 * Notifications from Manilla itself (#87): the browsers that said yes, and
 * telling them things.
 *
 * The alternative was ntfy, which still works (src/notify.ts), but it means
 * installing a second app and subscribing to a topic, and that is where a
 * household's second member gives up. This needs one tap in Settings on the
 * phone that already has Manilla on its home screen.
 *
 * Messages are encrypted to each browser (src/push/webpush.ts), so the push
 * services in between - Apple's, Google's, Mozilla's - carry them unread.
 * They still say what the ntfy ones say and no more, because a lock screen is
 * read by whoever is holding the phone.
 *
 * Everything here lives in the home database, beside the people it belongs to.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { appSettings, pushSubscriptions } from '../../db/schema.ts';
import { deliver, generateVapidKeys, vapidPublicKey, type Subscription, type VapidKeys } from './webpush.ts';

export const VAPID_KEY = 'push_vapid_key';

/** What a browser can be told about, each a switch of its own in Settings. */
export const PUSH_KINDS = ['sync', 'overspent', 'unusual', 'problems', 'signin'] as const;

export type PushKind = (typeof PUSH_KINDS)[number];

export type PushKinds = Record<PushKind, boolean>;

const COLUMNS = {
  sync: pushSubscriptions.sync,
  overspent: pushSubscriptions.overspent,
  unusual: pushSubscriptions.unusual,
  problems: pushSubscriptions.problems,
  signin: pushSubscriptions.signin,
} satisfies Record<PushKind, unknown>;

export type PushMessage = {
  title: string;
  body: string;
  /** The page a tap opens, as a path. */
  path?: string;
  urgent?: boolean;
};

export type PushDevice = PushKinds & {
  id: string;
  endpoint: string;
  label: string;
  createdAt: Date;
};

/**
 * This server's key pair, made the first time anyone asks.
 *
 * Kept in the database rather than the environment so there is nothing to set
 * up. The private half only lets its holder send to browsers whose addresses
 * they also have, and those are in the same table - anyone who can read one
 * can read both, and has the ledger besides.
 */
export async function vapidKeys(db: Database): Promise<VapidKeys> {
  const read = async () => {
    const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, VAPID_KEY));
    return row ? (JSON.parse(row.value) as VapidKeys) : null;
  };
  const existing = await read();
  if (existing) return existing;
  // Two first visits at once both make a key; the first one written wins, and
  // both go on to use it.
  await db
    .insert(appSettings)
    .values({ key: VAPID_KEY, value: JSON.stringify(generateVapidKeys()) })
    .onConflictDoNothing({ target: appSettings.key });
  return (await read())!;
}

export async function applicationServerKey(db: Database): Promise<string> {
  return vapidPublicKey(await vapidKeys(db));
}

/**
 * The push services browsers actually use: Google's for Chrome, Edge-on-Android,
 * Samsung and the rest of Chromium; Mozilla's; Apple's; Microsoft's for Edge on
 * Windows.
 *
 * The endpoint is a URL this server will POST to, handed over by whoever is
 * signed in. Without this list, saving `https://192.168.1.1/...` as a
 * "subscription" would have Manilla knock on doors inside its own network.
 */
const PUSH_SERVICE_HOSTS = ['googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];

export function checkSubscription(input: unknown): Subscription {
  const candidate = input as Partial<Subscription> | null;
  const endpoint = typeof candidate?.endpoint === 'string' ? candidate.endpoint : '';
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('That is not a push subscription.');
  }
  const known = PUSH_SERVICE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  if (url.protocol !== 'https:' || !known || endpoint.length > 1000) {
    throw new Error(`This browser's push service (${url.hostname}) is not one Manilla knows.`);
  }
  const p256dh = candidate?.keys?.p256dh;
  const auth = candidate?.keys?.auth;
  if (
    typeof p256dh !== 'string' ||
    typeof auth !== 'string' ||
    Buffer.from(p256dh, 'base64url').length !== 65 ||
    Buffer.from(auth, 'base64url').length !== 16
  ) {
    throw new Error('That push subscription is missing its keys.');
  }
  return { endpoint, keys: { p256dh, auth } };
}

/** "iPhone · Safari", "Android · Firefox": enough to tell one person's devices apart. */
export function deviceLabel(userAgent: string): string {
  const system = /iPhone/.test(userAgent)
    ? 'iPhone'
    : /iPad/.test(userAgent)
      ? 'iPad'
      : /Android/.test(userAgent)
        ? 'Android'
        : /CrOS/.test(userAgent)
          ? 'Chromebook'
          : /Macintosh/.test(userAgent)
            ? 'Mac'
            : /Windows/.test(userAgent)
              ? 'Windows'
              : /Linux/.test(userAgent)
                ? 'Linux'
                : null;
  // Order matters: every Chromium browser also says Chrome and Safari.
  const browser = /Edg(e|A|iOS)?\//.test(userAgent)
    ? 'Edge'
    : /Firefox|FxiOS/.test(userAgent)
      ? 'Firefox'
      : /SamsungBrowser/.test(userAgent)
        ? 'Samsung Internet'
        : /OPR\//.test(userAgent)
          ? 'Opera'
          : /Chrome|CriOS/.test(userAgent)
            ? 'Chrome'
            : /Safari/.test(userAgent)
              ? 'Safari'
              : null;
  return [system, browser].filter(Boolean).join(' · ') || 'A browser';
}

/**
 * Remember a browser for a person. The same browser saying yes again - or
 * another member signing in on it - updates the one row rather than adding a
 * second, so a shared tablet tells whoever last turned it on.
 */
export async function saveSubscription(
  db: Database,
  userId: string,
  subscription: Subscription,
  label: string,
): Promise<void> {
  await db
    .insert(pushSubscriptions)
    .values({ userId, endpoint: subscription.endpoint, ...subscription.keys, label })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId, ...subscription.keys, label },
    });
}

export async function listDevices(db: Database, userId: string): Promise<PushDevice[]> {
  return db
    .select({
      id: pushSubscriptions.id,
      endpoint: pushSubscriptions.endpoint,
      label: pushSubscriptions.label,
      ...COLUMNS,
      createdAt: pushSubscriptions.createdAt,
    })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .orderBy(pushSubscriptions.createdAt);
}

/** Only ever one of the person's own: the id comes from a form anyone signed in can post. */
export async function removeDevice(db: Database, userId: string, id: string): Promise<void> {
  await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)));
}

/** Any of the switches; the ones not named are left as they are. */
export async function setDeviceKinds(
  db: Database,
  userId: string,
  id: string,
  kinds: Partial<PushKinds>,
): Promise<void> {
  // Only the known switches, and only true or false: this comes from a form.
  const set = Object.fromEntries(
    PUSH_KINDS.filter((kind) => typeof kinds[kind] === 'boolean').map((kind) => [kind, kinds[kind]]),
  );
  if (Object.keys(set).length === 0) return;
  await db
    .update(pushSubscriptions)
    .set(set)
    .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)));
}

/** Whether anyone would hear about this kind of thing, so the sync can skip working out what to say. */
export async function anyoneListening(db: Database, kind: PushKind): Promise<boolean> {
  const [row] = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(COLUMNS[kind], true))
    .limit(1);
  return Boolean(row);
}

export type Recipients = {
  kind: PushKind;
  /** Someone who should not be told, because they did it. */
  except?: string | null;
};

/** What goes to the push service: the message for the browser, and who is sending it. */
function prepare(tag: string, message: PushMessage, options: PushOptions) {
  const origin = options.origin ?? process.env.MANILLA_ORIGIN;
  const payload = JSON.stringify({
    title: message.title,
    body: message.body.slice(0, 1000),
    url: origin && message.path ? new URL(message.path, origin).toString() : (message.path ?? '/'),
    // A newer one of the same kind replaces the last on the lock screen.
    tag,
  });
  // Apple refuses a request that does not say who is sending. Over plain http
  // (a dev server) there is no address worth giving, and nothing will check.
  const subject = origin?.startsWith('https:') ? origin : 'mailto:manilla@example.invalid';
  return { payload, subject };
}

/** A day: a phone off overnight still hears about last night's sync. */
const TTL = 24 * 60 * 60;

export type PushOptions = {
  /** MANILLA_ORIGIN: where a tap goes, and who the push services are told is sending. */
  origin?: string;
  fetch?: typeof fetch;
};

/**
 * Tell everyone who asked to hear about `kind`.
 *
 * In two halves, because sign-in activity must not wait on a push service:
 * working out who to tell is awaited, and `sent` settles when the messages
 * have gone, for a caller that has the time to wait.
 *
 * Never throws. A browser the push service no longer knows is forgotten.
 */
export async function notifyMembers(
  db: Database,
  recipients: Recipients,
  message: PushMessage,
  options: PushOptions = {},
): Promise<{ sent: Promise<number> }> {
  const none = { sent: Promise.resolve(0) };
  let targets: (typeof pushSubscriptions.$inferSelect)[];
  let keys: VapidKeys;
  try {
    const except = recipients.except;
    targets = (await db.select().from(pushSubscriptions).where(eq(COLUMNS[recipients.kind], true))).filter(
      (row) => row.userId !== except,
    );
    if (targets.length === 0) return none;
    keys = await vapidKeys(db);
  } catch (error) {
    console.warn(`[manilla] could not look up who to notify: ${String(error)}`);
    return none;
  }

  const { payload, subject } = prepare(recipients.kind, message, options);

  const sent = (async () => {
    const results = await Promise.all(
      targets.map(async (row) => ({
        row,
        result: await deliver(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          payload,
          keys,
          { ttl: TTL, urgent: message.urgent, subject, fetch: options.fetch },
        ),
      })),
    );
    const gone = results.filter(({ result }) => !result.ok && result.gone).map(({ row }) => row.id);
    // Every refusal is logged with what the push service said, a forgotten
    // browser included: "gone" is also how some services answer a request
    // they could not make sense of, and without its words that is a guess.
    for (const { row, result } of results) {
      if (result.ok) continue;
      const answer = `${result.status ?? 'no answer'}${result.reason ? ` ${result.reason}` : ''}`;
      console.warn(
        result.gone
          ? `[manilla] forgot ${row.label}, whose push service answered ${answer}`
          : `[manilla] a notification to ${row.label} failed: ${answer}`,
      );
    }
    try {
      if (gone.length > 0) await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, gone));
    } catch (error) {
      console.warn(`[manilla] could not forget unsubscribed browsers: ${String(error)}`);
    }
    return results.filter(({ result }) => result.ok).length;
  })();
  return { sent };
}

/**
 * The test button: one of a person's own browsers, whatever it has turned off,
 * waited for, and answered in words. When it fails, what the push service said
 * is the only clue to why, so it is shown rather than summarised.
 */
export async function testDevice(
  db: Database,
  userId: string,
  endpoint: string,
  options: PushOptions = {},
): Promise<{ ok: true } | { ok: false; error: string; forgotten: boolean }> {
  const [row] = await db
    .select()
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
  if (!row) {
    return { ok: false, forgotten: true, error: 'Manilla no longer has this device on its list. Turn notifications on again.' };
  }
  const { payload, subject } = prepare('test', { title: 'Manilla', body: 'Notifications are working on this device.', path: '/settings' }, options);
  const result = await deliver(
    { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
    payload,
    await vapidKeys(db),
    { ttl: TTL, subject, fetch: options.fetch },
  );
  if (result.ok) return { ok: true };
  const service = new URL(row.endpoint).hostname;
  const answer = `${result.status ?? 'no answer'}${result.reason ? `: ${result.reason}` : ''}`;
  console.warn(`[manilla] a test notification to ${row.label} was refused by ${service}: ${answer}`);
  if (result.gone) {
    await removeDevice(db, userId, row.id);
    return {
      ok: false,
      forgotten: true,
      error: `The push service (${service}) says this device is not subscribed (${answer}). Turn notifications on again.`,
    };
  }
  return { ok: false, forgotten: false, error: `The push service (${service}) refused it (${answer}).` };
}
