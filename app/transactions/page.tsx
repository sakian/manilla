import Link from 'next/link';
import { db } from '../../db/client.ts';
import { budgetMonth } from '../../src/budget/budget.ts';
import { currentMonth } from '../../src/budget/month.ts';
import { listAccountCategories } from '../../src/accounts/groups.ts';
import { transferOptions } from '../../src/envelopes/transfer.ts';
import { attention } from '../../src/notices/notices.ts';
import { filterChoices, isEmptyQuery, searchTransactions } from '../../src/transactions/search.ts';
import { requireUser } from '../auth.ts';
import { Hint } from '../Hint.tsx';
import { Notices } from '../Notices.tsx';
import { PAGE_SIZE, readForm, readPage, readQuery, withParams } from '../../src/transactions/urlQuery.ts';
import NewTransaction from './NewTransaction.tsx';
import TransactionFilters from './TransactionFilters.tsx';
import TransactionList from './TransactionList.tsx';
import { BalanceCheckpoints } from './BalanceCheckpoints.tsx';
import { balanceCheckpoints } from '../../src/import/ofxImport.ts';

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
  const query = readQuery(params);
  const page = readPage(params);
  const connection = db();

  const [found, choices, envelopes, report, categories, budget] = await Promise.all([
    searchTransactions(connection, query),
    filterChoices(connection),
    transferOptions(connection),
    attention(connection),
    listAccountCategories(connection, { includeArchived: true }),
    budgetMonth(connection, currentMonth()),
  ]);

  // Exactly one of something, so its own figures can stand above the list.
  const onlyEnvelope =
    query.envelopeIds?.length === 1 && query.envelopeIds[0] !== 'none'
      ? budget.rows.find((row) => row.envelopeId === query.envelopeIds![0])
      : undefined;
  const onlyAccount =
    query.accountIds?.length === 1
      ? categories
          .flatMap((category) => category.accounts.map((a) => ({ ...a, group: category.name })))
          .find((account) => account.id === query.accountIds![0])
      : undefined;

  // One account on screen: its statements' balances, to check the list against.
  const checkpoints = onlyAccount ? await balanceCheckpoints(connection, onlyAccount.id) : null;

  const empty = isEmptyQuery(query);
  const lastPage = Math.max(1, Math.ceil(found.total / PAGE_SIZE));
  const liveAccounts = choices.accounts
    .filter((account) => !account.archived)
    .map((account) => ({ id: account.id, name: account.name }));
  const envelopeChoices = envelopes.map((envelope) => ({
    id: envelope.id,
    name: envelope.name,
    groupName: envelope.groupName,
  }));

  return (
    <>
      <Notices report={report} />

      <div className="page-head">
        <div className="month-head">
          <h2>
            {onlyEnvelope?.name ?? onlyAccount?.name ?? 'Transactions'}{' '}
            <Hint label="What this screen shows">
              Every transaction in the ledger, filtered however you like. Arriving from an envelope
              or an account just sets a filter, so you can widen it, narrow it or clear it from here.
              Tap a transaction for its detail, where you can change which envelope it came out of.
              The CSV downloads exactly what the list is showing.
            </Hint>
          </h2>
          {/* Every screen's actions live in this row, in the same style. The CSV
              and New used to be a link buried in a sentence and a button inside
              the list; they are things you do to this screen, so they are here. */}
          <div className="head-actions">
            <Link href="/import" className="button-link head-button">
              Import
            </Link>
            <a className="button-link head-button" href={withParams('/api/search', params)} download>
              CSV
            </a>
            <NewTransaction
              accounts={liveAccounts}
              envelopes={envelopeChoices}
              {...(onlyAccount ? { defaultAccountId: onlyAccount.id } : {})}
            />
          </div>
        </div>
        {/* Balances, plans and account numbers are on the cards this screen is
            reached from, so repeating them here only pushed the list down. The
            one thing not reachable elsewhere is an envelope's allocations and
            transfers, which are not transactions - so that keeps its link. */}
        {onlyEnvelope && (
          <p className="muted">
            <Link href={`/envelopes/${onlyEnvelope.envelopeId}`}>
              Allocations and transfers for {onlyEnvelope.name}
            </Link>
          </p>
        )}
      </div>

      <section className="panel">
        <TransactionFilters
          path="/transactions"
          values={readForm(params)}
          accounts={choices.accounts}
          accountGroups={choices.accountGroups}
          envelopes={choices.envelopes}
          envelopeGroups={choices.envelopeGroups}
          active={!empty}
        />

        {onlyAccount && checkpoints && (
          <BalanceCheckpoints accountId={onlyAccount.id} checkpoints={checkpoints} />
        )}

        <TransactionList
          rows={found.rows}
          accounts={liveAccounts}
          envelopes={envelopeChoices}
          {...(onlyAccount ? { defaultAccountId: onlyAccount.id } : {})}
          showAccount={!onlyAccount}
          // The only place the count is stated, now the summary line is gone, so
          // it has to say it even when everything fits on one page.
          heading={
            found.total > found.rows.length
              ? `Showing ${found.offset + 1}–${found.offset + found.rows.length} of ${found.total.toLocaleString()}`
              : `${found.total.toLocaleString()} transaction${found.total === 1 ? '' : 's'}`
          }
        />

        {lastPage > 1 && (
          <div className="pager">
            {page > 1 ? (
              <Link href={withParams('/transactions', params, page - 1)}>← Newer</Link>
            ) : (
              <span className="muted">← Newer</span>
            )}
            <span className="muted">
              Page {page} of {lastPage.toLocaleString()}
            </span>
            {found.hasMore ? (
              <Link href={withParams('/transactions', params, page + 1)}>Older →</Link>
            ) : (
              <span className="muted">Older →</span>
            )}
          </div>
        )}
      </section>
    </>
  );
}
