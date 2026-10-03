import { ledgerDb } from '../ledger.ts';
import { attention } from '../../src/notices/notices.ts';
import { requireUser } from '../auth.ts';
import { Notices } from '../Notices.tsx';
import TransactionsView from './TransactionsView.tsx';

/**
 * Every transaction, one screen (VW-5, VW-6).
 *
 * There used to be a transaction list on the accounts screen, another on an
 * account's page, and a third that was its own search page. They were the same
 * list with different things pinned, so this is the one of them, and everything
 * that used to lead to a list of transactions now leads here with a filter
 * applied: an envelope card, an envelope group heading, an account card, an
 * account category heading.
 *
 * Which means a filter is not a detour from the page you wanted - it *is* the
 * page, and it can be widened, narrowed or cleared from where you landed. A
 * bookmark of any of those is a bookmark of a question.
 *
 * When exactly one envelope or account is being looked at, it names the screen -
 * but its balances and figures are not repeated here. They are on the card this
 * screen was reached from, and showing them twice only pushed the list down.
 */

export const dynamic = 'force-dynamic';

export default async function TransactionsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const params = await props.searchParams;
  const report = await attention(await ledgerDb());

  return (
    <>
      <Notices report={report} />
      <TransactionsView params={params} path="/transactions" />
    </>
  );
}
