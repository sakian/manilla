/**
 * What the nightly sync tells a phone (FR-16), when MANILLA_SYNC_NOTIFY_URL is set.
 *
 * One notification for a whole run, and none for a run that needs nothing:
 * a daily "nothing new" is how a feed teaches you to swipe it away unread.
 * Three things are worth a phone buzzing - transactions waiting for you to
 * review, an envelope the sync took below zero, and a bank that has stopped
 * until you sign in again, which is otherwise silent: the feed simply goes
 * quiet, and nothing says why until someone opens the app.
 *
 * Bank names, envelope names and counts only. The topic is on someone else's
 * server, so what it carries should be harmless to anyone who reads it: no
 * amounts, no payees, no account names.
 *
 * A separate topic from the sign-in alerts (src/auth/activity.ts), on purpose:
 * those must never be the thing you have learned to ignore.
 */

import { push } from '../notify.ts';
import type { ManagedGroup } from '../envelopes/manage.ts';

export type SyncOutcome = {
  /** The ledger's name, said only when there is more than one. */
  ledger: string;
  bank: string;
  added: number;
  held: number;
  /** Plaid's error code when the sync stopped. */
  error?: string;
};

/** What a ledger looks like once its sync has run. */
export type LedgerAfterSync = {
  /** Transactions waiting for review - the number a person acts on, whatever this run added to it. */
  waiting: number;
  /** Envelopes this run took below zero, by name (see `newlyOverdrawn`). */
  overdrawn: string[];
};

export type SyncNotice = { text: string; priority: 'high' | 'default' };

/** Past this many, the rest of the overdrawn envelopes are a count. */
const NAMED = 3;

/**
 * The envelopes that went below zero between two looks at a ledger: before its
 * sync, and after.
 *
 * Only the ones that crossed. An envelope already overdrawn stays on the home
 * screen, and saying so every night it is synced would be the daily message
 * that teaches you to swipe them all away. The income pool is left out: it is
 * not an envelope anyone overdraws by spending, and the app already shows
 * Available overdrawn as something broken.
 */
export function newlyOverdrawn(before: ManagedGroup[], after: ManagedGroup[]): string[] {
  const overdrawn = (groups: ManagedGroup[]) =>
    groups
      .flatMap((group) => group.envelopes)
      .filter((envelope) => !envelope.isUnallocated && envelope.archivedAt === null && envelope.balanceCents < 0);
  const already = new Set(overdrawn(before).map((envelope) => envelope.id));
  return overdrawn(after)
    .filter((envelope) => !already.has(envelope.id))
    .map((envelope) => envelope.name)
    .sort((left, right) => left.localeCompare(right));
}

/** "Groceries is", "Groceries and Dining are", "Dining, Fuel, Groceries and 2 more are". */
function overdrawnLine(names: string[]): string {
  const named = names.slice(0, NAMED);
  const rest = names.length - named.length;
  const parts = rest > 0 ? [...named, `${rest} more`] : named;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `${list} ${names.length === 1 ? 'is' : 'are'} now overdrawn.`;
}

const LOGIN_REQUIRED = 'ITEM_LOGIN_REQUIRED';

/** @param ledgers each synced ledger after its sync, by name. */
export function syncNotice(
  outcomes: SyncOutcome[],
  ledgers: Map<string, LedgerAfterSync>,
  options: { manyLedgers: boolean },
): SyncNotice | null {
  const lines: string[] = [];
  let urgent = false;

  for (const ledger of [...new Set(outcomes.map((outcome) => outcome.ledger))]) {
    const here = outcomes.filter((outcome) => outcome.ledger === ledger);
    const prefix = options.manyLedgers ? `${ledger}: ` : '';

    for (const outcome of here) {
      if (outcome.error === LOGIN_REQUIRED) {
        urgent = true;
        lines.push(`${prefix}${outcome.bank} wants you to sign in again. Nothing more comes in until you do.`);
      } else if (outcome.error) {
        lines.push(`${prefix}${outcome.bank} could not be synced (${outcome.error}). It tries again tomorrow.`);
      }
    }

    const news = here
      .filter((outcome) => outcome.added > 0 || outcome.held > 0)
      .map((outcome) =>
        [
          `${outcome.bank} ${outcome.added} new`,
          outcome.held > 0 ? `${outcome.held} held for you to check` : '',
        ]
          .filter(Boolean)
          .join(', '),
      );
    const after = ledgers.get(ledger);
    if (news.length > 0) {
      const count = after?.waiting ?? 0;
      lines.push(`${prefix}${news.join('; ')}.${count > 0 ? ` ${count} to review.` : ''}`);
    }
    if (after && after.overdrawn.length > 0) lines.push(`${prefix}${overdrawnLine(after.overdrawn)}`);
  }

  return lines.length > 0 ? { text: lines.join('\n'), priority: urgent ? 'high' : 'default' } : null;
}

/** Send it, tapping through to the app's home screen, where every notice is. */
export async function sendSyncNotice(url: string, notice: SyncNotice, origin: string | undefined): Promise<void> {
  await push(url, notice.text, {
    title: 'Manilla bank sync',
    priority: notice.priority,
    ...(origin ? { click: new URL('/', origin).toString() } : {}),
  });
}
