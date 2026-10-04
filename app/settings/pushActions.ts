'use server';

/**
 * Notifications from Manilla (#87): turning them on and off for a browser.
 *
 * Each person's own browsers only. The functions in src/push/push.ts match on
 * the signed-in member as well as the id, so a device id posted by somebody
 * else changes nothing.
 */

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { homeDb } from '../../db/client.ts';
import {
  checkSubscription,
  deviceLabel,
  notifyMembers,
  removeDevice,
  saveSubscription,
  setDeviceKinds,
  type PushKinds,
} from '../../src/push/push.ts';
import { requireUser } from '../auth.ts';
import { actAs } from '../../src/audit/actor.ts';
import type { Failure } from '../login/actions.ts';

type Result = { ok: true } | Failure;

function failed(error: unknown): Failure {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** `subscription` is what `PushSubscription.toJSON()` gave in the browser. */
export async function turnOnNotificationsAction(subscription: unknown): Promise<Result> {
  try {
    const session = actAs(await requireUser());
    const label = deviceLabel((await headers()).get('user-agent') ?? '');
    await saveSubscription(homeDb(), session.userId, checkSubscription(subscription), label);
    revalidatePath('/settings');
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/** Turning off on this browser, and removing another from the list, are the same row going. */
export async function removeNotificationDeviceAction(id: string): Promise<Result> {
  try {
    const session = actAs(await requireUser());
    await removeDevice(homeDb(), session.userId, id);
    revalidatePath('/settings');
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function setNotificationKindsAction(id: string, kinds: Partial<PushKinds>): Promise<Result> {
  try {
    const session = actAs(await requireUser());
    await setDeviceKinds(homeDb(), session.userId, id, kinds);
    revalidatePath('/settings');
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/** Waits for the push service's answer, so the button can say whether it took. */
export async function sendTestNotificationAction(endpoint: string): Promise<Result> {
  try {
    const session = actAs(await requireUser());
    const { sent } = await notifyMembers(
      homeDb(),
      { kind: 'test', user: session.userId, endpoint },
      { title: 'Manilla', body: 'Notifications are working on this device.', path: '/settings' },
    );
    if ((await sent) === 0) {
      return { ok: false, error: 'The push service did not take it. Try turning notifications off and on again.' };
    }
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}
