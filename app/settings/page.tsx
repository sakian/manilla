import Link from 'next/link';
import { cookies } from 'next/headers';
import { connectionFor, homeDb } from '../../db/client.ts';
import { allLedgers, currentLedger, ledgerDb } from '../ledger.ts';
import LedgersPanel from './LedgersPanel.tsx';
import { MAX_LEDGERS } from '../../src/ledgers/config.ts';
import { authConfig } from '../../src/auth/config.ts';
import { countUnusedRecoveryCodes, listDevices } from '../../src/auth/passkeys.ts';
import { listMembers, listPendingInvites } from '../../src/auth/invites.ts';
import { recentActivity } from '../../src/auth/activity.ts';
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
import { signOutAction } from '../login/actions.ts';
import Devices from './Devices.tsx';
import People from './People.tsx';
import SignInActivity from './SignInActivity.tsx';
import AiPanel from './AiPanel.tsx';
import DataPanel from './DataPanel.tsx';
import AppearancePanel from './AppearancePanel.tsx';
import BankFeedsPanel from './BankFeedsPanel.tsx';
import NotificationsPanel from './NotificationsPanel.tsx';
import { applicationServerKey, listDevices as listPushDevices } from '../../src/push/push.ts';
import { listConnections, unsyncable } from '../../src/sync/connections.ts';
import { fedElsewhere, feedKey } from '../../src/sync/shared.ts';
import { THEME_COOKIE, themeFrom } from '../../src/theme.ts';
import RuleSuggestions from './RuleSuggestions.tsx';
import Rules from './Rules.tsx';
import { displayDate, displayInstant } from '../../src/budget/month.ts';
import { readVersion } from '../../src/version.ts';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await requireUser();
  const connection = await ledgerDb();
  const [ledgers, current] = await Promise.all([allLedgers(), currentLedger()]);

  const [
    devices,
    unusedRecoveryCodes,
    members,
    invites,
    activity,
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
    bankConnections,
  ] = await Promise.all([
    // Sign-in is the same whichever ledger is open.
    listDevices(homeDb(), session.userId),
    countUnusedRecoveryCodes(homeDb(), session.userId),
    listMembers(homeDb()),
    listPendingInvites(homeDb()),
    recentActivity(homeDb()),
    listRules(connection),
    // Searched and counted together, so the notice that leads here always
    // agrees with what it finds.
    suggestAndCount(connection),
    dismissedRuleSuggestions(connection),
    transferOptions(connection),
    listAccounts(connection),
    exportLedger(connection),
    // One budget for the account, covering every ledger (LG-5).
    aiSettings(homeDb()),
    aiUsage(homeDb(), undefined, connection),
    accuracy(connection),
    unknownMerchantEstimate(connection),
    listConnections(connection),
  ]);
  const [pushDevices, serverKey] = await Promise.all([
    listPushDevices(homeDb(), session.userId),
    applicationServerKey(homeDb()),
  ]);

  // A bank login can feed accounts in any ledger, so the bank feeds panel
  // offers every ledger's accounts and says which ledger each one feeds.
  const handles = ledgers.map((ledger) => ({
    key: ledger.key,
    name: ledger.name,
    db: ledger.key === current.key ? connection : connectionFor(ledger.database),
  }));
  const [ledgerAccounts, elsewhere] = await Promise.all([
    Promise.all(
      handles.map(async (ledger) => ({
        key: ledger.key,
        name: ledger.name,
        accounts: (ledger.key === current.key ? accountChoices : await listAccounts(ledger.db)).map(
          ({ id, name }) => ({ id, name }),
        ),
      })),
    ),
    fedElsewhere(
      handles.find((ledger) => ledger.key === current.key)!,
      handles,
      bankConnections.map((bank) => bank.itemId),
    ),
  ]);
  const openFirst = [
    ...ledgerAccounts.filter((ledger) => ledger.key === current.key),
    ...ledgerAccounts.filter((ledger) => ledger.key !== current.key),
  ];

  const theme = themeFrom((await cookies()).get(THEME_COOKIE)?.value);

  let boundTo: string | null = null;
  try {
    boundTo = authConfig().origin;
  } catch {
    boundTo = null;
  }

  // Named one by one: the build writes these in where each is spelled out, and
  // the running server's own environment does not have them.
  const version = readVersion({
    MANILLA_COMMIT: process.env.MANILLA_COMMIT,
    MANILLA_COMMITTED: process.env.MANILLA_COMMITTED,
    MANILLA_MODIFIED: process.env.MANILLA_MODIFIED,
  });

  return (
    <>
      <div className="page-head">
        <h2>Settings</h2>
        <p className="muted page-status">
          Signed in as {session.userName}. This session lapses if unused, and ends for good on{' '}
          {displayInstant(session.endsAt)}.
        </p>
      </div>

      <RuleSuggestions
        suggestions={suggestions}
        total={suggestionTotal}
        capped={suggestionTotal >= SUGGESTION_COUNT_CAP}
      />

      <LedgersPanel ledgers={ledgers} currentKey={current.key} max={MAX_LEDGERS} />

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

      <BankFeedsPanel
        connections={bankConnections.map((bank) => ({
          id: bank.id,
          institutionName: bank.institutionName,
          errorCode: bank.errorCode,
          errorMessage: bank.errorMessage,
          lastSyncedAt: bank.lastSyncedAt?.toISOString() ?? null,
          accounts: bank.accounts.map(({ id, providerAccountId, name, mask, type, subtype, accountId, startDate }) => {
            const other = elsewhere.get(feedKey(bank.itemId, providerAccountId));
            return {
              id,
              name,
              mask,
              choice: accountId
                ? `${current.key}:${accountId}`
                : other
                  ? `${other.ledgerKey}:${other.accountId}`
                  : '',
              elsewhere: !accountId && other ? other.ledgerName : null,
              startDate: accountId ? startDate : (other?.startDate ?? null),
              unsyncable: unsyncable(type, subtype),
            };
          }),
        }))}
        ledgers={openFirst}
        missing={['PLAID_CLIENT_ID', 'PLAID_SECRET', 'MANILLA_SECRET_KEY'].filter((name) => !process.env[name])}
      />

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

      <NotificationsPanel devices={pushDevices} serverKey={serverKey} manyLedgers={ledgers.length > 1} />

      <AppearancePanel current={theme} />

      <People members={members} invites={invites} currentUserId={session.userId} />

      <Devices devices={devices} unusedRecoveryCodes={unusedRecoveryCodes} />

      <SignInActivity events={activity} />

      <section className="panel">
        <h3>This session</h3>
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
