import Link from 'next/link';
import { allLedgers, currentLedger, ledgerDb } from '../ledger.ts';
import { budgetMonth } from '../../src/budget/budget.ts';
import { currentMonth } from '../../src/budget/month.ts';
import { listAccountCategories } from '../../src/accounts/groups.ts';
import { transferOptions } from '../../src/envelopes/transfer.ts';
import { filterChoices, isEmptyQuery, searchTransactions } from '../../src/transactions/search.ts';
import { Hint } from '../Hint.tsx';
import { PAGE_SIZE, readForm, readPage, readQuery, withParams } from '../../src/transactions/urlQuery.ts';
import NewTransaction from './NewTransaction.tsx';
import TransactionFilters from './TransactionFilters.tsx';
import TransactionList from './TransactionList.tsx';
import { BalanceCheckpoints } from './BalanceCheckpoints.tsx';
import { balanceCheckpoints } from '../../src/import/ofxImport.ts';
import { envelopeActivity } from '../../src/envelopes/activity.ts';

/**
 * The transactions screen's contents, wherever they are shown (VW-5, VW-6, #35).
 *
 * The same list is its own page at /transactions and, on a wide screen, the
 * right half of the envelopes and accounts screens, beside the list a row is
 * chosen from. One component rather than a second list, so a filter, a row's
 * detail or a page of results behaves the same in both places, and "every list
 * of transactions is the one screen with something filtered" stays true.
 *
 * `path` is where its own navigation goes - filters, pages, clearing - so that
 * filtering inside a pane keeps you on the screen the pane is part of. In a pane
 * that navigation keeps the scroll position, because the list you chose from is
 * still beside it and jumping to the top would lose your place in it.
 */
export default async function TransactionsView({
  params,
  path,
  pane = false,
}: {
  params: Record<string, string | string[] | undefined>;
  path: '/transactions' | '/' | '/accounts';
  pane?: boolean;
}) {
  const query = readQuery(params);
  const page = readPage(params);
  const connection = await ledgerDb();
  const [ledgers, ledger] = await Promise.all([allLedgers(), currentLedger()]);
  const otherLedgers = ledgers
    .filter((other) => other.key !== ledger.key)
    .map(({ key, name }) => ({ key, name }));

  const [found, choices, envelopes, categories, budget] = await Promise.all([
    searchTransactions(connection, query),
    filterChoices(connection),
    transferOptions(connection),
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

  // One envelope, narrowed by nothing but dates: its whole history, fills and
  // transfers among the transactions, each row with the balance it left. Every
  // other filter - payee, account, "not reviewed", amount - is a question about
  // transactions that a move has no answer to, so with one of those the list is
  // transactions alone, as before.
  const envelopeHistory =
    onlyEnvelope &&
    !query.text?.trim() &&
    !query.payee?.trim() &&
    !query.memo?.trim() &&
    !query.accountIds?.length &&
    !query.accountGroupIds?.length &&
    !query.envelopeGroupIds?.length &&
    !query.status &&
    !query.kind &&
    query.minCents === undefined &&
    query.maxCents === undefined &&
    !query.direction &&
    (query.sort ?? 'date') === 'date'
      ? await envelopeActivity(connection, onlyEnvelope.envelopeId, {
          ...(query.from ? { from: query.from } : {}),
          ...(query.to ? { to: query.to } : {}),
          ...(query.order ? { order: query.order } : {}),
          ...(query.limit ? { limit: query.limit } : {}),
          ...(query.offset ? { offset: query.offset } : {}),
        })
      : null;
  const listed = envelopeHistory ?? found;
  const plural = (count: number) =>
    envelopeHistory ? (count === 1 ? 'entry' : 'entries') : count === 1 ? 'transaction' : 'transactions';

  const empty = isEmptyQuery(query);
  const lastPage = Math.max(1, Math.ceil(listed.total / PAGE_SIZE));
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
            {/* The screen a pane sits in has its own Import beside its title. */}
            {!pane && (
              <Link href="/import" className="button-link head-button">
                Import
              </Link>
            )}
            <a className="button-link head-button" href={withParams('/api/search', params)} download>
              CSV
            </a>
            <NewTransaction
              accounts={liveAccounts}
              envelopes={envelopeChoices}
              {...(onlyAccount ? { defaultAccountId: onlyAccount.id } : {})}
              ledgerName={ledger.name}
              otherLedgers={otherLedgers}
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
          path={path}
          keepScroll={pane}
          values={readForm(params)}
          accounts={choices.accounts}
          accountGroups={choices.accountGroups}
          envelopes={choices.envelopes}
          envelopeGroups={choices.envelopeGroups}
          active={!empty}
        />

        {onlyAccount && checkpoints && (
          <BalanceCheckpoints
            accountId={onlyAccount.id}
            checkpoints={checkpoints}
            path={path}
          />
        )}

        <TransactionList
          rows={found.rows}
          {...(envelopeHistory && onlyEnvelope
            ? { history: envelopeHistory.rows, historyEnvelopeId: onlyEnvelope.envelopeId }
            : {})}
          accounts={liveAccounts}
          envelopes={envelopeChoices}
          {...(onlyAccount ? { defaultAccountId: onlyAccount.id } : {})}
          showAccount={!onlyAccount}
          // The only place the count is stated, now the summary line is gone, so
          // it has to say it even when everything fits on one page.
          heading={
            listed.total > listed.rows.length
              ? `Showing ${listed.offset + 1}–${listed.offset + listed.rows.length} of ${listed.total.toLocaleString()}`
              : `${listed.total.toLocaleString()} ${plural(listed.total)}`
          }
        />

        {lastPage > 1 && (
          <div className="pager">
            {page > 1 ? (
              <Link href={withParams(path, params, page - 1)} scroll={!pane}>
                ← Newer
              </Link>
            ) : (
              <span className="muted">← Newer</span>
            )}
            <span className="muted">
              Page {page} of {lastPage.toLocaleString()}
            </span>
            {listed.hasMore ? (
              <Link href={withParams(path, params, page + 1)} scroll={!pane}>
                Older →
              </Link>
            ) : (
              <span className="muted">Older →</span>
            )}
          </div>
        )}
      </section>
    </>
  );
}
