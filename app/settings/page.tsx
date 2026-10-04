import Link from 'next/link';
import { homeDb } from '../../db/client.ts';
import { ledgerDb } from '../ledger.ts';
import { requireUser } from '../auth.ts';
import { ruleSuggestionCount } from '../../src/rules/rules.ts';
import { bankAttention } from '../../src/sync/connections.ts';
import { unseenActivity } from '../../src/auth/activity.ts';
import { displayInstant } from '../../src/budget/month.ts';
import { SETTINGS_GROUPS, type SettingsSlug } from './groups.ts';

export const dynamic = 'force-dynamic';

/**
 * The menu. Each group says what is in it, and what in it wants a decision,
 * so nothing that needs doing is hidden behind a tap that does not say so.
 * The counts are the cheap, cached ones the notices use.
 */
export default async function SettingsMenu() {
  const session = await requireUser();
  const connection = await ledgerDb();
  const [suggestions, bank, unseen] = await Promise.all([
    ruleSuggestionCount(connection),
    bankAttention(connection),
    unseenActivity(homeDb(), session.userId),
  ]);

  const waiting: Partial<Record<SettingsSlug, string>> = {
    ...(unseen.length > 0 ? { household: `${unseen.length} new` } : {}),
    ...(bank.loginNeeded.length > 0
      ? { ledgers: bank.loginNeeded.length === 1 ? 'A bank to sign in to' : `${bank.loginNeeded.length} banks to sign in to` }
      : {}),
    ...(suggestions > 0 ? { sorting: `${suggestions} rule${suggestions === 1 ? '' : 's'} to suggest` } : {}),
  };

  return (
    <>
      <div className="page-head">
        <h2>Settings</h2>
        <p className="muted page-status">
          Signed in as {session.userName}. This session lapses if unused, and ends for good on{' '}
          {displayInstant(session.endsAt)}.
        </p>
      </div>

      <nav className="panel settings-menu" aria-label="Settings">
        {SETTINGS_GROUPS.map((group) => (
          <Link key={group.slug} href={`/settings/${group.slug}`} className="settings-item">
            <span className="settings-item-text">
              <span className="settings-item-title">
                {group.title}
                {waiting[group.slug] && <span className="settings-badge">{waiting[group.slug]}</span>}
              </span>
              <span className="muted">{group.summary}</span>
            </span>
          </Link>
        ))}
      </nav>
    </>
  );
}
