import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import {
  deliver,
  encrypt,
  generateVapidKeys,
  vapidAuthorization,
  vapidPublicKey,
  type Subscription,
} from './webpush.ts';

const b64 = (text: string) => Buffer.from(text, 'base64url');

test('encryption matches the worked example in RFC 8291, appendix A', () => {
  const subscription: Subscription = {
    endpoint: 'https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV',
    keys: {
      p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    },
  };
  const body = encrypt(Buffer.from('When I grow up, I want to be a watermelon'), subscription, {
    salt: b64('DGv6ra1nlYgDCS1FRnbzlw'),
    senderPrivateKey: b64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
  });
  assert.equal(
    body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  );
});

/** What the browser does on receipt, so a fresh message is checked end to end. */
function decrypt(body: Buffer, receiver: ReturnType<typeof createECDH>, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);

  const shared = receiver.computeSecret(senderPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), receiver.getPublicKey(), senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  assert.equal(padded.at(-1), 2, 'a single, final record');
  return padded.subarray(0, -1).toString();
}

function browser() {
  const receiver = createECDH('prime256v1');
  receiver.generateKeys();
  const auth = randomBytes(16);
  const subscription: Subscription = {
    endpoint: 'https://push.example.net/send/abc',
    keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  };
  return { receiver, auth, subscription };
}

test('a fresh message decrypts on the receiving end, and differs every time', () => {
  const { receiver, auth, subscription } = browser();
  const text = JSON.stringify({ title: 'Manilla bank sync', body: 'Vancity 3 new. 3 to review.' });
  const first = encrypt(Buffer.from(text), subscription);
  const second = encrypt(Buffer.from(text), subscription);
  assert.equal(decrypt(first, receiver, auth), text);
  assert.notDeepEqual(first, second);
});

test('the VAPID token is signed by the key the browser subscribed with', () => {
  const keys = generateVapidKeys();
  const now = new Date('2026-10-04T12:00:00Z');
  const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/xyz', keys, 'https://manilla.example', now);

  const [, token, publicKey] = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
  assert.equal(publicKey, vapidPublicKey(keys));
  assert.equal(b64(publicKey!).length, 65);

  const [head, claims, signature] = token!.split('.');
  assert.deepEqual(JSON.parse(b64(claims!).toString()), {
    aud: 'https://fcm.googleapis.com',
    exp: now.getTime() / 1000 + 12 * 60 * 60,
    sub: 'https://manilla.example',
  });
  const raw = b64(publicKey!);
  const key = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
    format: 'jwk',
  });
  assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, b64(signature!)));
});

test('delivery says when a browser has gone, and never throws', async () => {
  const { receiver, auth, subscription } = browser();
  const keys = generateVapidKeys();
  const seen: { headers: Headers; body: Buffer }[] = [];
  const answering = (status: number) =>
    (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push({ headers: new Headers(init!.headers), body: Buffer.from(init!.body as Uint8Array) });
      return new Response(status === 201 ? null : 'nope', { status });
    }) as typeof fetch;
  const options = { ttl: 3600, subject: 'https://manilla.example' };

  assert.deepEqual(await deliver(subscription, 'hello', keys, { ...options, urgent: true, fetch: answering(201) }), { ok: true, status: 201 });
  assert.equal(seen[0]!.headers.get('content-encoding'), 'aes128gcm');
  assert.equal(seen[0]!.headers.get('ttl'), '3600');
  assert.equal(seen[0]!.headers.get('urgency'), 'high');
  assert.equal(decrypt(seen[0]!.body, receiver, auth), 'hello');

  assert.deepEqual(await deliver(subscription, 'x', keys, { ...options, fetch: answering(410) }), { ok: false, gone: true, status: 410, reason: 'nope' });
  assert.deepEqual(await deliver(subscription, 'x', keys, { ...options, fetch: answering(404) }), { ok: false, gone: true, status: 404, reason: 'nope' });
  const busy = await deliver(subscription, 'x', keys, { ...options, fetch: answering(429) });
  assert.equal(busy.ok || busy.gone, false);

  const unreachable = await deliver(subscription, 'x', keys, {
    ...options,
    fetch: (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch,
  });
  assert.deepEqual(unreachable.ok, false);
});
