import Link from 'next/link';
import { homeDb } from '../db/client.ts';
import { summarizeUnseen, unseenActivity } from '../src/auth/activity.ts';
import { currentSession } from './auth.ts';
import { markActivitySeenAction } from './settings/actions.ts';

/**
 * Sign-in activity this member has not seen, as one notice (NF-3).
 *
 * It sits with the other notices but is not one of `src/notices`: those are
 * about a ledger's money, and this is about the household's way in, which is the
 * same whichever ledger is open. "Seen" is a plain form, so it works before any
 * script has loaded.
 */
export async function SignInActivityNotice() {
  const session = await currentSession();
  if (!session) return null;
  const summary = summarizeUnseen(await unseenActivity(homeDb(), session.userId));
  if (!summary) return null;

  return (
    <li className={`notice ${summary.urgent ? 'bad' : 'warn'} with-action`}>
      <Link href="/settings#sign-in-activity">{summary.text}</Link>
      <form action={markActivitySeenAction}>
        <button type="submit" className="notice-action">
          Seen
        </button>
      </form>
    </li>
  );
}
