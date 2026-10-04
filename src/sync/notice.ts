/**
 * What the nightly sync tells a phone (FR-16), when MANILLA_SYNC_NOTIFY_URL is set.
 *
 * One notification for a whole run, and none for a run that needs nothing:
 * a daily "nothing new" is how a feed teaches you to swipe it away unread.
 * Two things are worth a phone buzzing - transactions waiting for you to
 * review, and a bank that has stopped until you sign in again, which is
 * otherwise silent: the feed simply goes quiet, and nothing says why until
 * someone opens the app.
 *
 * Bank names and counts only. The topic is on someone else's server, so what
 * it carries should be harmless to anyone who reads it: no amounts, no
 * payees, no account names.
 *
 * A separate topic from the sign-in alerts (src/auth/activity.ts), on purpose:
 * those must never be the thing you have learned to ignore.
 */

import { push } from '../notify.ts';

export type SyncOutcome = {
  /** The ledger's name, said only when there is more than one. */
  ledger: string;
  bank: string;
  added: number;
  held: number;
  /** Plaid's error code when the sync stopped. */
  error?: string;
};

export type SyncNotice = { text: string; priority: 'high' | 'default' };

const LOGIN_REQUIRED = 'ITEM_LOGIN_REQUIRED';

/**
 * @param waiting each ledger's count of transactions waiting for review, after
 *   the sync - the number a person acts on, whatever this run added to it.
 */
export function syncNotice(
  outcomes: SyncOutcome[],
  waiting: Map<string, number>,
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
    if (news.length > 0) {
      const count = waiting.get(ledger) ?? 0;
      lines.push(`${prefix}${news.join('; ')}.${count > 0 ? ` ${count} to review.` : ''}`);
    }
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
