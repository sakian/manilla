import { cookies } from 'next/headers';
import { homeDb } from '../../../db/client.ts';
import { allLedgers } from '../../ledger.ts';
import { requireUser } from '../../auth.ts';
import { authConfig } from '../../../src/auth/config.ts';
import { countUnusedRecoveryCodes, listDevices } from '../../../src/auth/passkeys.ts';
import { applicationServerKey, listDevices as listPushDevices } from '../../../src/push/push.ts';
import { THEME_COOKIE, themeFrom } from '../../../src/theme.ts';
import { displayInstant } from '../../../src/budget/month.ts';
import { signOutEverywhereAction } from '../actions.ts';
import { signOutAction } from '../../login/actions.ts';
import SettingsHead from '../SettingsHead.tsx';
import NotificationsPanel from '../NotificationsPanel.tsx';
import AppearancePanel from '../AppearancePanel.tsx';
import Devices from '../Devices.tsx';

export const dynamic = 'force-dynamic';

/** What is yours, and mostly this device's: sign-in is the same whichever ledger is open. */
export default async function YouSettings() {
  const session = await requireUser();
  const [devices, unusedRecoveryCodes, pushDevices, serverKey, ledgers] = await Promise.all([
    listDevices(homeDb(), session.userId),
    countUnusedRecoveryCodes(homeDb(), session.userId),
    listPushDevices(homeDb(), session.userId),
    applicationServerKey(homeDb()),
    allLedgers(),
  ]);
  const theme = themeFrom((await cookies()).get(THEME_COOKIE)?.value);

  let boundTo: string | null = null;
  try {
    boundTo = authConfig().origin;
  } catch {
    boundTo = null;
  }

  return (
    <>
      <SettingsHead slug="you" status={`Signed in as ${session.userName}.`} />

      <NotificationsPanel devices={pushDevices} serverKey={serverKey} manyLedgers={ledgers.length > 1} />

      <AppearancePanel current={theme} />

      <Devices devices={devices} unusedRecoveryCodes={unusedRecoveryCodes} />

      <section className="panel">
        <h3>This session</h3>
        <p className="muted">
          It lapses if unused, and ends for good on {displayInstant(session.endsAt)}.
        </p>
        {boundTo && (
          <p className="muted">
            Passkeys on this install are bound to <code>{boundTo}</code>. Reaching Manilla on a
            different hostname means your existing passkeys will not be offered.
          </p>
        )}
        {/* Plain Sign out as well: on a phone the header leaves it out, and
            this is where it went. */}
        <form action={signOutEverywhereAction} className="signin-actions">
          <button type="submit" formAction={signOutAction}>
            Sign out
          </button>
          <button type="submit">Sign out everywhere</button>
        </form>
      </section>
    </>
  );
}
