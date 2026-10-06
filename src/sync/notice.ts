/**
 * What a sync tells a phone (FR-16): the browsers that turned each kind on in
 * Settings (src/push/push.ts), and MANILLA_SYNC_NOTIFY_URL if set. A sync here
 * is the daily one, or one Plaid's webhook started (webhook.ts) - not the Sync
 * button, whose own answer is on the screen of whoever pressed it.
 *
 * Up to three notifications for a whole run, each its own so each can be
 * turned off on its own, and none for a run that needs nothing: a daily
 * "nothing new" is how a feed teaches you to swipe it away unread.
 *
 *  - The bank sync itself: transactions waiting for you to review, income that
 *    has arrived to give to envelopes, and a bank that has stopped until you
 *    sign in again, which is otherwise silent - the feed simply goes quiet, and
 *    nothing says why until someone opens the app.
 *  - Envelopes the sync took below zero.
 *  - Charges the sync brought in that look out of the ordinary (AI-1).
 *
 * Bank names, envelope names and counts only. An ntfy topic is on someone
 * else's server, and a lock screen is read by whoever holds the phone, so what
 * it carries should be harmless to anyone who reads it: no amounts, no payees,
 * no account names.
 *
 * A separate topic from the sign-in alerts (src/auth/activity.ts), on purpose:
 * those must never be the thing you have learned to ignore.
 */

import { push } from '../notify.ts';
import type { ManagedGroup } from '../envelopes/manage.ts';
import type { Insight } from '../insights/insights.ts';

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
  /** Whether this run put money in the income pool (see `incomeArrived`). */
  income?: boolean;
  /** Unusual charges this run brought in (see `newlyUnusual`). */
  unusual?: Insight[];
};

/** Which switch in Settings each one answers to. */
export type SyncNoticeKind = 'sync' | 'overspent' | 'unusual';

export type SyncNotice = { kind: SyncNoticeKind; text: string; priority: 'high' | 'default' };

export const TITLES: Record<SyncNoticeKind, string> = {
  sync: 'Manilla bank sync',
  overspent: 'Manilla overspent envelopes',
  unusual: 'Manilla unusual charges',
};

/** Past this many, the rest of the overdrawn envelopes are a count. */
const NAMED = 3;

const envelopesOf = (groups: ManagedGroup[]) =>
  groups.flatMap((group) => group.envelopes).filter((envelope) => envelope.archivedAt === null);

/**
 * The envelopes that went below zero between two looks at a ledger: before its
 * sync, and after.
 *
 * Only the ones that crossed. An envelope already overdrawn stays on the home
 * screen, and saying so every night it is synced would be the daily message
 * that teaches you to swipe them all away. The income pool is left out: it is
 * not an envelope anyone overdraws by spending, and the app already shows
 * Available overdrawn as something broken. So is an envelope marked as going
 * below zero by design (FR-24): that is what it is for.
 */
export function newlyOverdrawn(before: ManagedGroup[], after: ManagedGroup[]): string[] {
  const overdrawn = (groups: ManagedGroup[]) =>
    envelopesOf(groups).filter(
      (envelope) => !envelope.isUnallocated && !envelope.mayGoNegative && envelope.balanceCents < 0,
    );
  const already = new Set(overdrawn(before).map((envelope) => envelope.id));
  return overdrawn(after)
    .filter((envelope) => !already.has(envelope.id))
    .map((envelope) => envelope.name)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Whether the sync left more in the income pool than it found, and something
 * there to give out.
 *
 * Only income a rule or the payee's history placed counts: a deposit nothing
 * recognised waits in the review queue with no envelope, and is said as one
 * more to review instead.
 */
export function incomeArrived(before: ManagedGroup[], after: ManagedGroup[]): boolean {
  const pool = (groups: ManagedGroup[]) =>
    envelopesOf(groups)
      .filter((envelope) => envelope.isUnallocated)
      .reduce((sum, envelope) => sum + envelope.balanceCents, 0);
  const now = pool(after);
  return now > pool(before) && now > 0;
}

/** Unusual charges found after the sync and not before it: the ones it brought in. */
export function newlyUnusual(before: Insight[], after: Insight[]): Insight[] {
  const already = new Set(before.map((insight) => insight.transactionId));
  return after.filter((insight) => !already.has(insight.transactionId));
}

/** "Groceries is", "Groceries and Dining are", "Dining, Fuel, Groceries and 2 more are". */
function overdrawnLine(names: string[]): string {
  const named = names.slice(0, NAMED);
  const rest = names.length - named.length;
  const parts = rest > 0 ? [...named, `${rest} more`] : named;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `${list} ${names.length === 1 ? 'is' : 'are'} now overdrawn.`;
}

/** What was found, without the payee or the amount: the app has both, a lock screen should not. */
function unusualLine(insights: Insight[]): string {
  const jumped = insights.filter((insight) => insight.kind === 'charge_jumped').length;
  const large = insights.length - jumped;
  const parts = [
    jumped === 1 ? 'a regular charge came in well above its usual' : jumped > 1 ? `${jumped} regular charges came in well above their usual` : '',
    large === 1 ? 'a large first charge from a new payee' : large > 1 ? `${large} large first charges from new payees` : '',
  ].filter(Boolean);
  const text = parts.join(', and ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

const LOGIN_REQUIRED = 'ITEM_LOGIN_REQUIRED';

/** The bank sync's own notice: what came in, and banks that stopped. */
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
    if (after?.income) lines.push(`${prefix}Income came in: Available has money to give to envelopes.`);
  }

  return lines.length > 0 ? { kind: 'sync', text: lines.join('\n'), priority: urgent ? 'high' : 'default' } : null;
}

/** One line per ledger from what each ledger said after its sync, or nothing. */
function perLedger(
  kind: SyncNoticeKind,
  ledgers: Map<string, LedgerAfterSync>,
  options: { manyLedgers: boolean },
  line: (after: LedgerAfterSync) => string | null,
): SyncNotice | null {
  const lines = [...ledgers].flatMap(([ledger, after]) => {
    const text = line(after);
    return text ? [`${options.manyLedgers ? `${ledger}: ` : ''}${text}`] : [];
  });
  return lines.length > 0 ? { kind, text: lines.join('\n'), priority: 'default' } : null;
}

/** Everything a run has to say, one notice per kind that has something. */
export function syncNotices(
  outcomes: SyncOutcome[],
  ledgers: Map<string, LedgerAfterSync>,
  options: { manyLedgers: boolean },
): SyncNotice[] {
  return [
    syncNotice(outcomes, ledgers, options),
    perLedger('overspent', ledgers, options, (after) => (after.overdrawn.length > 0 ? overdrawnLine(after.overdrawn) : null)),
    perLedger('unusual', ledgers, options, (after) => (after.unusual?.length ? unusualLine(after.unusual) : null)),
  ].filter((notice): notice is SyncNotice => notice !== null);
}

/** Send one to ntfy, tapping through to the app's home screen, where every notice is. */
export async function sendSyncNotice(url: string, notice: SyncNotice, origin: string | undefined): Promise<void> {
  await push(url, notice.text, {
    title: TITLES[notice.kind],
    priority: notice.priority,
    ...(origin ? { click: new URL('/', origin).toString() } : {}),
  });
}
