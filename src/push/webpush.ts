/**
 * Web Push, the protocol: what it takes to hand a browser's push service a
 * message only that browser can read.
 *
 * Two RFCs and nothing else. RFC 8291 encrypts the message to the keys the
 * browser gave when it subscribed, so Apple, Google and Mozilla carry it without
 * being able to read it. RFC 8292 (VAPID) signs the request with this server's
 * own key, so the push service delivers only messages from whoever the browser
 * subscribed to. Both are a few calls into node:crypto, which is why this is
 * here rather than a dependency.
 */

import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type JsonWebKey,
} from 'node:crypto';

/** What `PushSubscription.toJSON()` gives in the browser. */
export type Subscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/** This server's VAPID key pair, as stored: an EC P-256 private key in JWK form. */
export type VapidKeys = { privateJwk: JsonWebKey };

/** One record holds the whole message; 4096 is what every push service accepts. */
const RECORD_SIZE = 4096;

const b64url = (data: Buffer | Uint8Array) => Buffer.from(data).toString('base64url');
const fromB64url = (text: string) => Buffer.from(text, 'base64url');

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateJwk: privateKey.export({ format: 'jwk' }) };
}

/** The public key a browser subscribes with (`applicationServerKey`): 0x04 || x || y. */
export function vapidPublicKey(keys: VapidKeys): string {
  const { x, y } = keys.privateJwk;
  return b64url(Buffer.concat([Buffer.from([4]), fromB64url(x!), fromB64url(y!)]));
}

/**
 * The Authorization header for one push service (RFC 8292).
 *
 * `subject` is how the push service's operator could reach whoever runs this
 * server; Apple refuses a request without one.
 */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  now: Date = new Date(),
): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        // At most a day ahead, by the RFC; twelve hours leaves room for a clock
        // that is a little out.
        exp: Math.floor(now.getTime() / 1000) + 12 * 60 * 60,
        sub: subject,
      }),
    ),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: createPrivateKey({ key: keys.privateJwk, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${vapidPublicKey(keys)}`;
}

/**
 * The message, encrypted for one browser (RFC 8291, `aes128gcm`).
 *
 * `salt` and `senderPrivateKey` are fresh for every message; they are
 * parameters only so the RFC's own worked example can be checked.
 */
export function encrypt(
  plaintext: Buffer,
  subscription: Subscription,
  fixed: { salt?: Buffer; senderPrivateKey?: Buffer } = {},
): Buffer {
  const receiverPublic = fromB64url(subscription.keys.p256dh);
  const authSecret = fromB64url(subscription.keys.auth);
  const salt = fixed.salt ?? randomBytes(16);

  const sender = createECDH('prime256v1');
  if (fixed.senderPrivateKey) sender.setPrivateKey(fixed.senderPrivateKey);
  else sender.generateKeys();
  const senderPublic = sender.getPublicKey();
  const shared = sender.computeSecret(receiverPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiverPublic, senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  // 0x02 marks the last (and only) record.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublic.length, 20);
  return Buffer.concat([header, senderPublic, body]);
}

export type Delivery =
  | { ok: true }
  /** The browser has unsubscribed, or the push service has forgotten it: stop sending. */
  | { ok: false; gone: true; status: number; reason: string }
  | { ok: false; gone: false; status: number | null; reason: string };

export type SendOptions = {
  /** How long the push service should keep trying a phone that is off, in seconds. */
  ttl: number;
  urgent?: boolean;
  subject: string;
  fetch?: typeof fetch;
};

/** Send one message to one browser. Never throws: a phone that cannot be told is not an error in what told it. */
export async function deliver(
  subscription: Subscription,
  payload: string,
  keys: VapidKeys,
  options: SendOptions,
): Promise<Delivery> {
  try {
    const response = await (options.fetch ?? fetch)(subscription.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapidAuthorization(subscription.endpoint, keys, options.subject),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(options.ttl),
        urgency: options.urgent ? 'high' : 'normal',
      },
      body: new Uint8Array(encrypt(Buffer.from(payload), subscription)),
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) return { ok: true };
    const reason = (await response.text()).slice(0, 200).trim();
    if (response.status === 404 || response.status === 410) return { ok: false, gone: true, status: response.status, reason };
    return { ok: false, gone: false, status: response.status, reason };
  } catch (error) {
    return { ok: false, gone: false, status: null, reason: String(error) };
  }
}
