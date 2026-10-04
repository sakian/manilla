'use client';

/**
 * Notifications from Manilla itself, turned on per device (#87).
 *
 * One button, because the person this is for will not install a second app or
 * type a topic name. Everything the browser decides - whether it can at all,
 * whether it was refused - is found out here rather than on the server, which
 * cannot see it.
 */

import { useCallback, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  removeNotificationDeviceAction,
  sendTestNotificationAction,
  setNotificationKindsAction,
  turnOnNotificationsAction,
} from './pushActions.ts';
import { displayInstant } from '../../src/budget/month.ts';
import type { PushDevice, PushKind, PushKinds } from '../../src/push/push.ts';

type Device = PushDevice;

/** In the order a person meets them: the sync, what it found, then what is wrong. */
const SWITCHES: [PushKind, string, string][] = [
  ['sync', 'Bank sync', 'What came in each night, income to give to envelopes, and a bank that wants you to sign in again'],
  ['overspent', 'Overspent envelopes', 'Envelopes the sync took below zero'],
  ['unusual', 'Unusual charges', 'A regular charge well above its usual, or a large first charge from a new payee'],
  ['problems', 'Problems', 'A ledger that no longer adds up, or the server’s disk filling'],
  ['signin', 'Sign-in activity', 'Someone adding a passkey, using a recovery code, or joining'],
];

/** What this browser can do, once it has been asked. */
type Support = 'checking' | 'unsupported' | 'home-screen' | 'blocked' | 'ready';

/** iPadOS calls itself a Mac, and only its touch screen gives it away. */
function isApple(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function sameKey(subscription: PushSubscription, serverKey: string): boolean {
  const key = subscription.options.applicationServerKey;
  if (!key) return false;
  const expected = keyBytes(serverKey);
  const actual = new Uint8Array(key);
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}

export default function NotificationsPanel({
  devices,
  serverKey,
  manyLedgers,
}: {
  devices: Device[];
  serverKey: string;
  /** Whether to say these cover every ledger, beside panels that are about the open one. */
  manyLedgers: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [support, setSupport] = useState<Support>('checking');
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      // Safari on an iPhone has none of these until Manilla is opened from the
      // Home Screen, which is the one thing worth telling someone there.
      setSupport(isApple() ? 'home-screen' : 'unsupported');
      return;
    }
    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => {
        setEndpoint(subscription?.endpoint ?? null);
        setSupport(Notification.permission === 'denied' ? 'blocked' : 'ready');
      })
      .catch(() => setSupport('unsupported'));
  }, []);

  const here = endpoint ? devices.find((device) => device.endpoint === endpoint) : undefined;

  const turnOn = useCallback(async () => {
    setError(null);
    setNote(null);
    // First, before anything else is awaited: Safari only asks while it can
    // still see the tap that led here.
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      if (permission === 'denied') setSupport('blocked');
      else setError('Nothing changed: the browser was not told yes.');
      return;
    }
    startTransition(async () => {
      try {
        const registration = await navigator.serviceWorker.ready;
        let subscription = await registration.pushManager.getSubscription();
        // One made for another server key cannot carry this server's messages.
        if (subscription && !sameKey(subscription, serverKey)) {
          await subscription.unsubscribe();
          subscription = null;
        }
        subscription ??= await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(serverKey),
        });
        const result = await turnOnNotificationsAction(subscription.toJSON());
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setEndpoint(subscription.endpoint);
        router.refresh();
      } catch (caught) {
        setError(`The browser would not subscribe: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    });
  }, [router, serverKey]);

  const turnOff = useCallback(() => {
    if (!here) return;
    setError(null);
    setNote(null);
    startTransition(async () => {
      const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      await subscription?.unsubscribe();
      const result = await removeNotificationDeviceAction(here.id);
      if (!result.ok) setError(result.error);
      setEndpoint(null);
      router.refresh();
    });
  }, [here, router]);

  const test = useCallback(() => {
    if (!endpoint) return;
    setError(null);
    setNote(null);
    startTransition(async () => {
      const result = await sendTestNotificationAction(endpoint);
      if (result.ok) {
        setNote('Sent. It should appear in a few seconds.');
        return;
      }
      setError(result.error);
      // Dropped on the server: show it as off, so Turn on is the next step.
      if ('forgotten' in result && result.forgotten) router.refresh();
    });
  }, [endpoint, router]);

  const remove = useCallback(
    (device: Device) => {
      if (!window.confirm(`Stop sending notifications to ${device.label}?`)) return;
      startTransition(async () => {
        const result = await removeNotificationDeviceAction(device.id);
        if (!result.ok) setError(result.error);
        router.refresh();
      });
    },
    [router],
  );

  const choose = useCallback(
    (device: Device, kinds: Partial<PushKinds>) => {
      startTransition(async () => {
        const result = await setNotificationKindsAction(device.id, kinds);
        if (!result.ok) setError(result.error);
        router.refresh();
      });
    },
    [router],
  );

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Notifications</h3>
        {support === 'ready' &&
          (here ? (
            <button onClick={turnOff} disabled={pending}>
              Turn off
            </button>
          ) : (
            <button className="primary" onClick={turnOn} disabled={pending}>
              Turn on
            </button>
          ))}
      </div>

      {error && <p className="signin-error">{error}</p>}
      {note && <p className="queue-note">{note}</p>}

      <p className="muted">
        {here ? 'On for this device. ' : support === 'ready' ? 'Off for this device. ' : ''}
        {manyLedgers && 'These cover every ledger, whichever one is open. '}
        Names and counts, never amounts or payees.
      </p>

      {support === 'home-screen' && (
        <p className="budget-warning">
          On an iPhone or iPad, Manilla can only send notifications once it is on your Home Screen. In
          Safari, tap Share, then Add to Home Screen, and open Manilla from there.
        </p>
      )}
      {support === 'unsupported' && <p className="budget-warning">This browser cannot show notifications.</p>}
      {support === 'blocked' && (
        <p className="budget-warning">
          Notifications for Manilla are blocked on this device. Allow them in the browser&rsquo;s site
          settings, or the phone&rsquo;s own Settings, then come back here.
        </p>
      )}

      {/* The one in your hand first: it is the one you came here about. */}
      {[...devices].sort((left, right) => Number(right.id === here?.id) - Number(left.id === here?.id)).map((device) => (
        <div key={device.id} className="notify-device">
          <div className="row notify-head">
            <span>
              {device.label}
              {device.id === here?.id && <span className="tag">this device</span>}
              <span className="muted notify-added">added {displayInstant(device.createdAt)}</span>
            </span>
            <span className="device-actions">
              {device.id === here?.id ? (
                <button onClick={test} disabled={pending}>
                  Send a test
                </button>
              ) : (
                <button onClick={() => remove(device)} disabled={pending}>
                  Remove
                </button>
              )}
            </span>
          </div>
          <div className="notify-kinds">
            {SWITCHES.map(([kind, label, hint]) => (
              <label key={kind}>
                <input
                  type="checkbox"
                  checked={device[kind]}
                  disabled={pending}
                  onChange={(event) => choose(device, { [kind]: event.target.checked })}
                />
                <span>
                  {label}
                  <span className="muted">{hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
