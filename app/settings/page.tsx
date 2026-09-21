import Link from 'next/link';
import { db } from '../../db/client.ts';
import { authConfig } from '../../src/auth/config.ts';
import { countUnusedRecoveryCodes, listDevices } from '../../src/auth/passkeys.ts';
import {
  SUGGESTION_COUNT_CAP,
  dismissedRuleSuggestions,
  listRules,
  suggestAndCount,
} from '../../src/rules/rules.ts';
import { transferOptions } from '../../src/envelopes/transfer.ts';
import { listAccounts } from '../../src/accounts/manage.ts';
import { exportLedger } from '../../src/export/export.ts';
import { accuracy, aiSettings, aiUsage, unknownMerchantEstimate } from '../../src/ai/ai.ts';
import { requireUser } from '../auth.ts';
import { signOutEverywhereAction } from './actions.ts';
import Devices from './Devices.tsx';
import AiPanel from './AiPanel.tsx';
import DataPanel from './DataPanel.tsx';
import RuleSuggestions from './RuleSuggestions.tsx';
import Rules from './Rules.tsx';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await requireUser();
  const connection = db();

  const [
    devices,
    unusedRecoveryCodes,
    rules,
    { suggestions, total: suggestionTotal },
    declined,
    envelopeChoices,
    accountChoices,
    ledger,
    ai,
    usage,
    quality,
    unknown,
  ] = await Promise.all([
    listDevices(connection, session.userId),
    countUnusedRecoveryCodes(connection, session.userId),
    listRules(connection),
    // Searched and counted together, so the notice that leads here always
    // agrees with what it finds.
    suggestAndCount(connection),
    dismissedRuleSuggestions(connection),
    transferOptions(connection),
    listAccounts(connection),
    exportLedger(connection),
    aiSettings(connection),
    aiUsage(connection),
    accuracy(connection),
    unknownMerchantEstimate(connection),
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

      <RuleSuggestions
        suggestions={suggestions}
        total={suggestionTotal}
        capped={suggestionTotal >= SUGGESTION_COUNT_CAP}
      />

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
      </section>

      <DataPanel
        counts={{
          transactions: ledger.counts.transactions ?? 0,
          envelopes: ledger.counts.envelopes ?? 0,
        }}
      />

      <AiPanel
        enabled={ai.enabled}
        budget={ai.monthlyCallBudget}
        usage={usage}
        accuracy={quality}
        unknownMerchants={unknown}
        keyPresent={Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN)}
      />

      <Rules
        rules={rules}
        declined={declined}
        envelopes={envelopeChoices.map(({ id, name, groupName }) => ({ id, name, groupName }))}
        accounts={accountChoices.map(({ id, name }) => ({ id, name }))}
      />

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
