import Link from 'next/link';
import { db } from '../../db/client.ts';
import { budgetMonth } from '../../src/budget/budget.ts';
import { currentMonth } from '../../src/budget/month.ts';
import { listAccountCategories } from '../../src/accounts/groups.ts';
import { accountKindLabel } from '../../src/accounts/manage.ts';
import { transferOptions } from '../../src/envelopes/transfer.ts';
import { attention } from '../../src/notices/notices.ts';
import {
  describeQuery,
  filterChoices,
  isEmptyQuery,
  searchTransactions,
} from '../../src/transactions/search.ts';
import { requireUser } from '../auth.ts';
import { Hint } from '../Hint.tsx';
import { Money, Spend } from '../Money.tsx';
import { Notices } from '../Notices.tsx';
import { PAGE_SIZE, readForm, readPage, readQuery, withParams } from '../search/urlQuery.ts';
import TransactionFilters from './TransactionFilters.tsx';
import TransactionList from './TransactionList.tsx';

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
 * When exactly one envelope or one account is being looked at, its own figures are
 * shown above the list, so arriving here from a card does not lose what the card
 * was telling you.
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

  const names = {
    accounts: new Map(choices.accounts.map((row) => [row.id, row.name])),
    accountGroups: new Map(choices.accountGroups.map((row) => [row.id, row.name])),
    envelopes: new Map(choices.envelopes.map((row) => [row.id, row.name])),
    envelopeGroups: new Map(choices.envelopeGroups.map((row) => [row.id, row.name])),
  };

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

  const empty = isEmptyQuery(query);
  const lastPage = Math.max(1, Math.ceil(found.total / PAGE_SIZE));

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
          <div className="head-actions">
            {!empty && (
              <Link href="/transactions" className="button-link head-button">
                Everything
              </Link>
            )}
            <Link href="/import" className="button-link head-button">
              Import
            </Link>
          </div>
        </div>
        {onlyEnvelope && (
          <p className="muted">
            {onlyEnvelope.groupName} ·{' '}
            <Link href={`/envelopes/${onlyEnvelope.envelopeId}`}>
              allocations and transfers for this envelope
            </Link>
          </p>
        )}
        {onlyAccount && (
          <p className="muted">
            {onlyAccount.group} · {accountKindLabel(onlyAccount.kind)}
            {onlyAccount.externalAccountId && ` · no. ${onlyAccount.externalAccountId}`}
          </p>
        )}
      </div>

      {/* The figures the card that brought you here was showing. */}
      {onlyEnvelope && (
        <div className="callouts">
          <div className={`callout${onlyEnvelope.balanceCents < 0 ? ' bad' : ''}`}>
            Balance <strong>{<Money cents={onlyEnvelope.balanceCents} plain />}</strong>
          </div>
          <div className="callout">
            Planned <strong>{<Money cents={onlyEnvelope.plannedCents} plain />}</strong>
          </div>
          <div className={`callout${onlyEnvelope.spentCents < 0 ? ' received' : ''}`}>
            This month <strong>{<Spend cents={onlyEnvelope.spentCents} />}</strong>
          </div>
        </div>
      )}
      {onlyAccount && (
        <div className="callouts">
          <div className={`callout${onlyAccount.balanceCents < 0 ? ' bad' : ''}`}>
            Balance <strong>{<Money cents={onlyAccount.balanceCents} plain />}</strong>
          </div>
          <div className="callout">
            {onlyAccount.transactionCount.toLocaleString()} in all
          </div>
          <div className="callout">Last activity {onlyAccount.lastActivity ?? 'nothing yet'}</div>
        </div>
      )}

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

        <p className="muted">
          {empty
            ? `${found.total.toLocaleString()} transaction${found.total === 1 ? '' : 's'}`
            : `${describeQuery(query, names)} · ${found.total.toLocaleString()} found`}
          , spent <Money cents={found.outCents} plain />, received{' '}
          <Money cents={found.inCents} plain /> ·{' '}
          <a className="button-link" href={withParams('/api/search', params)} download>
            CSV
          </a>
        </p>

        <TransactionList
          rows={found.rows}
          accounts={choices.accounts
            .filter((account) => !account.archived)
            .map((account) => ({ id: account.id, name: account.name }))}
          envelopes={envelopes.map((envelope) => ({
            id: envelope.id,
            name: envelope.name,
            groupName: envelope.groupName,
          }))}
          {...(onlyAccount ? { defaultAccountId: onlyAccount.id } : {})}
          showAccount={!onlyAccount}
          heading={
            found.total > found.rows.length
              ? `Showing ${found.offset + 1}–${found.offset + found.rows.length} of ${found.total.toLocaleString()}`
              : 'Transactions'
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
