import Link from 'next/link';
import { db } from '../../db/client.ts';
import { transferOptions } from '../../src/envelopes/transfer.ts';
import {
  describeQuery,
  filterChoices,
  isEmptyQuery,
  searchTransactions,
} from '../../src/transactions/search.ts';
import { requireUser } from '../auth.ts';
import { Money } from '../Money.tsx';
import TransactionFilters from '../transactions/TransactionFilters.tsx';
import TransactionList from '../transactions/TransactionList.tsx';
import { PAGE_SIZE, readForm, readPage, readQuery, withParams } from './urlQuery.ts';

/**
 * Search across every transaction (VW-6).
 *
 * The same query the account view runs, with nothing pinned. Results are a page
 * at a time with the full count beside them, because "how many" and "how much"
 * are usually the actual question and a page of rows cannot answer either.
 */

export const dynamic = 'force-dynamic';

export default async function SearchPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const params = await props.searchParams;
  const query = readQuery(params);
  const page = readPage(params);
  const connection = db();

  const [found, choices, envelopes] = await Promise.all([
    searchTransactions(connection, query),
    filterChoices(connection),
    transferOptions(connection),
  ]);

  const accountNames = new Map(choices.accounts.map((account) => [account.id, account.name]));
  const envelopeNames = new Map(choices.envelopes.map((envelope) => [envelope.id, envelope.name]));
  const empty = isEmptyQuery(query);
  const lastPage = Math.max(1, Math.ceil(found.total / PAGE_SIZE));

  return (
    <>
      <div className="page-head">
        <h2>Search</h2>
        <p className="muted">
          Every transaction, filtered however you like. What you see is what the CSV downloads, and
          the address bar holds the search, so it can be bookmarked.
        </p>
      </div>

      <section className="panel">
        <TransactionFilters
          path="/search"
          values={readForm(params)}
          accounts={choices.accounts}
          envelopes={choices.envelopes}
          active={!empty}
        />
      </section>

      <div className="callouts">
        <div className="callout">
          <strong>{found.total.toLocaleString()}</strong>{' '}
          {found.total === 1 ? 'transaction' : 'transactions'}
        </div>
        {/* Spending as a positive number, the way the reports state it: "out
            -$412.50" reads as a refund to everyone except a programmer. The net
            figure keeps its sign, because there the sign is the answer. */}
        <div className="callout">
          Spent <Money cents={found.outCents} plain />
        </div>
        <div className="callout">
          Received <Money cents={found.inCents} plain />
        </div>
        <div className="callout">
          Net <Money cents={found.totalCents} />
        </div>
      </div>

      <section className="panel">
        <p className="muted">
          {describeQuery(query, { accounts: accountNames, envelopes: envelopeNames })}.{' '}
          {found.total > 0 && (
            <a className="button-link" href={withParams('/api/search', params)} download>
              CSV
            </a>
          )}
        </p>

        <TransactionList
          heading={
            found.total > found.rows.length
              ? `Showing ${found.offset + 1}–${found.offset + found.rows.length} of ${found.total.toLocaleString()}`
              : 'Results'
          }
          rows={found.rows}
          accounts={choices.accounts
            .filter((account) => !account.archived)
            .map((account) => ({ id: account.id, name: account.name }))}
          envelopes={envelopes.map((envelope) => ({
            id: envelope.id,
            name: envelope.name,
            groupName: envelope.groupName,
          }))}
          showAccount
        />

        {lastPage > 1 && (
          <div className="pager">
            {page > 1 ? (
              <Link href={withParams('/search', params, page - 1)}>← Newer</Link>
            ) : (
              <span className="muted">← Newer</span>
            )}
            <span className="muted">
              Page {page} of {lastPage.toLocaleString()}
            </span>
            {found.hasMore ? (
              <Link href={withParams('/search', params, page + 1)}>Older →</Link>
            ) : (
              <span className="muted">Older →</span>
            )}
          </div>
        )}
      </section>
    </>
  );
}
