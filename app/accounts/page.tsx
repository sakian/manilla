import Link from 'next/link';
import { db } from '../../db/client.ts';
import { listAccounts } from '../../src/accounts/manage.ts';
import { transferOptions } from '../../src/envelopes/transfer.ts';
import {
  describeQuery,
  filterChoices,
  isEmptyQuery,
  searchTransactions,
} from '../../src/transactions/search.ts';
import { requireUser } from '../auth.ts';
import { Hint } from '../Hint.tsx';
import { Money } from '../Money.tsx';
import { PAGE_SIZE, readForm, readPage, readQuery, withParams } from '../search/urlQuery.ts';
import TransactionFilters from '../transactions/TransactionFilters.tsx';
import TransactionList from '../transactions/TransactionList.tsx';
import AccountManager from './AccountManager.tsx';

/**
 * Accounts, and the transactions in them (FR-1, VW-5).
 *
 * `?account=` both picks the account and filters the list, because they are the
 * same thing said twice otherwise. The rest of the filters are the search page's,
 * running the same query - so a filter learned in one place works in the other.
 */

export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AccountsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const params = await props.searchParams;
  const connection = db();

  const managed = await listAccounts(connection, { includeArchived: true });
  const requested = one(params.account);
  const selected = managed.find((account) => account.id === requested) ?? null;

  // An `?account=` naming something that no longer exists filters on nothing
  // rather than on a dead id, which would silently show an empty list.
  const query = readQuery(selected ? params : { ...params, account: undefined }, {
    pageSize: PAGE_SIZE,
  });
  const page = readPage(params);

  const [found, choices, envelopes] = await Promise.all([
    searchTransactions(connection, query),
    filterChoices(connection),
    transferOptions(connection),
  ]);

  const accountNames = new Map(choices.accounts.map((account) => [account.id, account.name]));
  const envelopeNames = new Map(choices.envelopes.map((envelope) => [envelope.id, envelope.name]));
  const filtered = !isEmptyQuery({ ...query, accountIds: undefined });
  const lastPage = Math.max(1, Math.ceil(found.total / PAGE_SIZE));

  const live = managed
    .filter((account) => account.archivedAt === null)
    .map((account) => ({ id: account.id, name: account.name }));

  return (
    <>
      <div className="page-head">
        <h2>
          Accounts{' '}
          <Hint label="What this screen shows">
          Real money, as the bank sees it. Every transaction is here: search and filter below, and
            pick an account to narrow it to one. The CSV downloads exactly what the list is
            showing.
          </Hint>
        </h2>
      </div>

      <AccountManager accounts={managed} selectedId={selected?.id ?? null} />

      <section className="panel">
        {selected && (
          <p className="muted">
            Showing {selected.name}. <Link href="/accounts">Show every account</Link>
          </p>
        )}

        <TransactionFilters
          path="/accounts"
          values={readForm(params)}
          accounts={choices.accounts}
          envelopes={choices.envelopes}
          {...(selected ? { pinnedAccountId: selected.id } : {})}
          active={filtered}
        />

        {/* The CSV is offered whether or not anything is filtered: it downloads
            exactly what the list is showing, and "export my transactions" is a
            thing people look for without having searched first (#12). */}
        <p className="muted">
          {filtered ? (
            <>
              {describeQuery(query, { accounts: accountNames, envelopes: envelopeNames })} ·{' '}
              {found.total.toLocaleString()} found, spent <Money cents={found.outCents} plain />
              {found.inCents > 0 && (
                <>
                  , received <Money cents={found.inCents} plain />
                </>
              )}
            </>
          ) : (
            <>
              {found.total.toLocaleString()} transaction{found.total === 1 ? '' : 's'}, spent{' '}
              <Money cents={found.outCents} plain />, received{' '}
              <Money cents={found.inCents} plain />
            </>
          )}{' '}
          ·{' '}
          <a className="button-link" href={withParams('/api/search', params)} download>
            CSV
          </a>
        </p>

        <TransactionList
          rows={found.rows}
          accounts={live}
          envelopes={envelopes.map((envelope) => ({
            id: envelope.id,
            name: envelope.name,
            groupName: envelope.groupName,
          }))}
          {...(selected ? { defaultAccountId: selected.id } : {})}
          {...(filtered
            ? {
                heading:
                  found.total > found.rows.length
                    ? `Showing ${found.offset + 1}–${found.offset + found.rows.length} of ${found.total.toLocaleString()}`
                    : 'Matching transactions',
              }
            : {})}
          showAccount={!selected}
        />

        {lastPage > 1 && (
          <div className="pager">
            {page > 1 ? (
              <Link href={withParams('/accounts', params, page - 1)}>← Newer</Link>
            ) : (
              <span className="muted">← Newer</span>
            )}
            <span className="muted">
              Page {page} of {lastPage.toLocaleString()}
            </span>
            {found.hasMore ? (
              <Link href={withParams('/accounts', params, page + 1)}>Older →</Link>
            ) : (
              <span className="muted">Older →</span>
            )}
          </div>
        )}
      </section>
    </>
  );
}
