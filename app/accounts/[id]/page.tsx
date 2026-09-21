import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '../../../db/client.ts';
import { listAccountCategories } from '../../../src/accounts/groups.ts';
import { accountKindLabel } from '../../../src/accounts/manage.ts';
import { transferOptions } from '../../../src/envelopes/transfer.ts';
import { attention } from '../../../src/notices/notices.ts';
import {
  describeQuery,
  filterChoices,
  isEmptyQuery,
  searchTransactions,
} from '../../../src/transactions/search.ts';
import { requireUser } from '../../auth.ts';
import { Hint } from '../../Hint.tsx';
import { Money } from '../../Money.tsx';
import { Notices } from '../../Notices.tsx';
import { PAGE_SIZE, readForm, readPage, readQuery, withParams } from '../../search/urlQuery.ts';
import TransactionFilters from '../../transactions/TransactionFilters.tsx';
import TransactionList from '../../transactions/TransactionList.tsx';

/**
 * One account: what it holds, and what has happened in it (VW-5).
 *
 * Shaped like an envelope's page, because it answers the same question about the
 * other half of the ledger.
 *
 * The account filter is a filter, not the route. `?account=all` widens the list to
 * every account while staying on this page, which is how searching across
 * everything is done now that the accounts screen is a list of accounts.
 */

export const dynamic = 'force-dynamic';

/** Widens the list to every account without leaving this page. */
const EVERY_ACCOUNT = 'all';

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AccountPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const { id } = await props.params;
  const params = await props.searchParams;
  const connection = db();

  const categories = await listAccountCategories(connection, { includeArchived: true });
  const all = categories.flatMap((category) =>
    category.accounts.map((account) => ({ ...account, groupName: category.name })),
  );
  const account = all.find((candidate) => candidate.id === id);
  if (!account) notFound();

  // The route's account is the default; `?account=` overrides it, and `all` clears
  // it altogether. Everything else in the query string is an ordinary filter.
  const chosen = one(params.account);
  const everyAccount = chosen === EVERY_ACCOUNT;
  const query = readQuery(
    { ...params, account: everyAccount ? undefined : (chosen ?? id) },
    { pageSize: PAGE_SIZE },
  );
  const page = readPage(params);

  const [found, choices, envelopes, report] = await Promise.all([
    searchTransactions(connection, query),
    filterChoices(connection),
    transferOptions(connection),
    attention(connection),
  ]);

  const accountNames = new Map(choices.accounts.map((row) => [row.id, row.name]));
  const envelopeNames = new Map(choices.envelopes.map((row) => [row.id, row.name]));
  const filtered = !isEmptyQuery({ ...query, accountIds: undefined });
  const lastPage = Math.max(1, Math.ceil(found.total / PAGE_SIZE));
  const here = `/accounts/${id}`;

  return (
    <>
      <Notices report={report} />

      <div className="page-head">
        <div className="month-head">
          <h2>
            {account.name}{' '}
            <Hint label="What this screen shows">
              Everything recorded in this account, newest first. Tap a transaction to see its detail
              and change where it went. Search and filter below; widening the account filter to every
              account searches the whole ledger from here.
            </Hint>
          </h2>
          <div className="head-actions">
            <Link href="/import" className="button-link head-button">
              Import
            </Link>
            <Link href="/accounts" className="button-link head-button">
              All accounts
            </Link>
          </div>
        </div>
        <p className="muted">
          {account.groupName} · {accountKindLabel(account.kind)}
          {account.externalAccountId && ` · no. ${account.externalAccountId}`}
        </p>
      </div>

      <div className="callouts">
        <div className={`callout${account.balanceCents < 0 ? ' bad' : ''}`}>
          Balance <strong>{<Money cents={account.balanceCents} plain />}</strong>
        </div>
        <div className="callout">
          {account.transactionCount.toLocaleString()} transaction
          {account.transactionCount === 1 ? '' : 's'}
        </div>
        <div className="callout">Last activity {account.lastActivity ?? 'nothing yet'}</div>
      </div>

      <section className="panel">
        <TransactionFilters
          path={here}
          values={readForm({ ...params, account: everyAccount ? EVERY_ACCOUNT : (chosen ?? id) })}
          accounts={choices.accounts}
          envelopes={choices.envelopes}
          everyAccountValue={EVERY_ACCOUNT}
          active={filtered || everyAccount}
        />

        <p className="muted">
          {everyAccount ? 'Every account · ' : ''}
          {filtered
            ? describeQuery(query, { accounts: accountNames, envelopes: envelopeNames })
            : `${found.total.toLocaleString()} transaction${found.total === 1 ? '' : 's'}`}
          , spent <Money cents={found.outCents} plain />, received{' '}
          <Money cents={found.inCents} plain /> ·{' '}
          <a className="button-link" href={withParams('/api/search', params, 1, { account: query.accountIds?.[0] ?? '' })} download>
            CSV
          </a>
        </p>

        <TransactionList
          rows={found.rows}
          accounts={choices.accounts
            .filter((candidate) => !candidate.archived)
            .map((candidate) => ({ id: candidate.id, name: candidate.name }))}
          envelopes={envelopes.map((envelope) => ({
            id: envelope.id,
            name: envelope.name,
            groupName: envelope.groupName,
          }))}
          defaultAccountId={id}
          showAccount={everyAccount}
          heading={
            found.total > found.rows.length
              ? `Showing ${found.offset + 1}–${found.offset + found.rows.length} of ${found.total.toLocaleString()}`
              : 'Transactions'
          }
        />

        {lastPage > 1 && (
          <div className="pager">
            {page > 1 ? (
              <Link href={withParams(here, params, page - 1)}>← Newer</Link>
            ) : (
              <span className="muted">← Newer</span>
            )}
            <span className="muted">
              Page {page} of {lastPage.toLocaleString()}
            </span>
            {found.hasMore ? (
              <Link href={withParams(here, params, page + 1)}>Older →</Link>
            ) : (
              <span className="muted">Older →</span>
            )}
          </div>
        )}
      </section>
    </>
  );
}
