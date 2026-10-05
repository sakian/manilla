import Link from 'next/link';
import { ledgerDb } from '../../ledger.ts';
import { requireUser } from '../../auth.ts';
import { exportLedger } from '../../../src/export/export.ts';
import { displayDate } from '../../../src/budget/month.ts';
import { readVersion } from '../../../src/version.ts';
import SettingsHead from '../SettingsHead.tsx';
import DataPanel from '../DataPanel.tsx';

export const dynamic = 'force-dynamic';

export default async function DataSettings() {
  await requireUser();
  const ledger = await exportLedger(await ledgerDb());

  // Named one by one: the build writes these in where each is spelled out, and
  // the running server's own environment does not have them.
  const version = readVersion({
    MANILLA_COMMIT: process.env.MANILLA_COMMIT,
    MANILLA_COMMITTED: process.env.MANILLA_COMMITTED,
    MANILLA_MODIFIED: process.env.MANILLA_MODIFIED,
  });

  return (
    <>
      <SettingsHead slug="data" />

      {/* Migration happens once, so it does not need a place in the navigation -
          but it does need to be findable a second time, which is what a settings
          screen is for. */}
      <section className="panel">
        <div className="panel-head">
          <h3>Bring in a history</h3>
          <Link href="/migrate" className="button-link">
            Open the migration
          </Link>
        </div>
        <p className="muted">
          A multi-year export from another envelope budgeting app: its envelopes, splits, income and
          transfers. Nothing is written until you have seen what it would do, and the whole thing can
          be undone in one step.
        </p>
        <p className="muted">
          Already brought one in? <Link href="/migrate/reconcile">Reconcile its balances</Link>{' '}
          against what your old app showed.
        </p>
      </section>

      <DataPanel
        counts={{
          transactions: ledger.counts.transactions ?? 0,
          envelopes: ledger.counts.envelopes ?? 0,
        }}
      />

      {/* What a bug report asks for, and what says whether an update arrived (#20). */}
      <section className="panel">
        <h3>Version</h3>
        {version ? (
          <p className="muted">
            Commit <code>{version.commit}</code>
            {version.committed && <>, made {displayDate(version.committed)}</>}
            {version.modified && ', built with changes not yet committed'}.
          </p>
        ) : (
          <p className="muted">
            This build could not tell which commit it is: it was made somewhere without git.
          </p>
        )}
      </section>
    </>
  );
}
