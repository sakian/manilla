/**
 * Open a page in a particular ledger (LG-3), for a notification about one
 * ledger tapped while another is open: "Alex handed you 2 transactions to
 * review in Business" should land on Business's list, not an empty one.
 *
 * A GET because a notification can only open a URL. All it changes is which
 * ledger this browser has open, the same preference the ledger menu sets, and
 * only to a ledger that exists for someone signed in. Where it goes next is a
 * path on this site and nothing else (`safePath`).
 */

import { redirect } from 'next/navigation';
import { currentSession } from '../auth.ts';
import { allLedgers, rememberLedger } from '../ledger.ts';
import { safePath } from '../../src/safePath.ts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const to = safePath(params.get('to'));
  // The proxy has already sent anyone without a cookie to sign in; this is the
  // real check, and it brings them back here once they have.
  if (!(await currentSession())) {
    redirect(`/login?next=${encodeURIComponent(`/open?${params.toString()}`)}`);
  }
  const ledger = (await allLedgers()).find((candidate) => candidate.key === params.get('ledger'));
  if (ledger) await rememberLedger(ledger.key);
  redirect(to);
}
