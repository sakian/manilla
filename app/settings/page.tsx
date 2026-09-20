import { db } from '../../db/client.ts';
import { authConfig } from '../../src/auth/config.ts';
import { countUnusedRecoveryCodes, listDevices } from '../../src/auth/passkeys.ts';
import { listRules } from '../../src/rules/rules.ts';
import { exportLedger } from '../../src/export/export.ts';
import { requireUser } from '../auth.ts';
import { signOutEverywhereAction } from './actions.ts';
import Devices from './Devices.tsx';
import DataPanel from './DataPanel.tsx';
import Rules from './Rules.tsx';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await requireUser();
  const connection = db();

  const [devices, unusedRecoveryCodes, rules, ledger] = await Promise.all([
    listDevices(connection, session.userId),
    countUnusedRecoveryCodes(connection, session.userId),
    listRules(connection),
    exportLedger(connection),
  ]);

  let boundTo: string | null = null;
  try {
    boundTo = authConfig().origin;
  } catch {
    boundTo = null;
  }

  return (
    <>
      <div className="page-head">
        <h2>Settings</h2>
        <p className="muted">
          Signed in as {session.userName}. This session lapses if unused, and ends for good on{' '}
          {session.endsAt.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })}
          .
        </p>
      </div>

      <DataPanel
        counts={{
          transactions: ledger.counts.transactions ?? 0,
          envelopes: ledger.counts.envelopes ?? 0,
        }}
      />

      <Rules rules={rules} />

      <Devices devices={devices} unusedRecoveryCodes={unusedRecoveryCodes} />

      <section className="panel">
        <h3>This session</h3>
        {boundTo && (
          <p className="muted">
            Passkeys on this install are bound to <code>{boundTo}</code>. Reaching Manilla on a
            different hostname means your existing passkeys will not be offered.
          </p>
        )}
        <form action={signOutEverywhereAction} className="signin-actions">
          <button type="submit">Sign out everywhere</button>
        </form>
      </section>
    </>
  );
}
