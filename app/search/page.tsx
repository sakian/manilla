import { redirect } from 'next/navigation';
import { withParams } from '../../src/transactions/urlQuery.ts';

/**
 * Search has no page of its own any more: every transaction list is `/transactions`
 * with a filter, so that is where a saved search goes - filters and all.
 *
 * This pointed at `/accounts` for a while, from the one release where the account
 * view with nothing picked *was* the full list. That screen takes no search
 * parameters, so every filter on a saved link was dropped on the way through and
 * the link quietly showed the wrong thing - worse than a 404, which at least says
 * so. It went unnoticed because nothing under `app/` is reachable by the test
 * runner; the carrying is `withParams`, which is now in `src/` and covered.
 */
export default async function SearchPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(withParams('/transactions', await props.searchParams));
}
