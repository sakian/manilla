'use client';

/**
 * The filter bar above a transaction list (VW-5, VW-6).
 *
 * One component for both places the filters appear. On the account view the
 * account is pinned - it is already the thing being looked at - and that control
 * is left out rather than shown with one option.
 *
 * The controls are single-select, though the query layer underneath accepts
 * several accounts or envelopes at once: a native multi-select is unusable on a
 * phone, and one at a time answers the question nearly always being asked.
 * Somebody who wants two envelopes can still say `?env=a&env=b` by hand.
 *
 * Filters are applied on submit, not per keystroke. Every change is a database
 * query and a navigation, and a search box that reloads six times while a
 * merchant name is typed is slower to use than one that waits for Enter.
 */

import { useCallback, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { UNCATEGORIZED } from '../../src/transactions/search.ts';
import { writeQuery, type FormValues } from '../../src/transactions/urlQuery.ts';
import { displayDate } from '../../src/budget/month.ts';

export type FilterChoice = { id: string; name: string; archived?: boolean };
export type EnvelopeFilterChoice = { id: string; name: string; groupName: string };
export type GroupFilterChoice = { id: string; name: string };

export default function TransactionFilters({
  path,
  values,
  accounts,
  accountGroups,
  envelopes,
  envelopeGroups,
  pinnedAccountId,
  everyAccountValue,
  active,
}: {
  /** Where to navigate: the transactions page, or an account's own view. */
  path: string;
  values: FormValues;
  accounts: FilterChoice[];
  accountGroups?: GroupFilterChoice[];
  envelopes: EnvelopeFilterChoice[];
  envelopeGroups?: GroupFilterChoice[];
  /** Set on the account view, where the account is the page rather than a filter. */
  pinnedAccountId?: string;
  /**
   * The value the account control uses for "every account". On an account's own
   * page the absence of a filter would mean "this account", so widening to all of
   * them has to be said explicitly rather than by leaving the box empty.
   */
  everyAccountValue?: string;
  /** Whether anything is currently being filtered, so "Clear" can be hidden. */
  active: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState<FormValues>(values);
  /**
   * Closed on arrival, even when filters are applied. Landing here from an
   * envelope card means one filter is set and none of the other ten need to be on
   * screen; the summary line under the bar already says what is being shown.
   */
  const [open, setOpen] = useState(false);

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const go = useCallback(
    (next: FormValues) => {
      const query = writeQuery({
        ...next,
        // The pinned account travels as the same `account` param, so a link from
        // here to the full search keeps the account filter it was showing.
        accounts: pinnedAccountId ? [pinnedAccountId] : next.accounts,
      });
      // Applying is the end of choosing, so the panel folds away and leaves the
      // chips to say what was chosen.
      setOpen(false);
      router.push(query ? `${path}?${query}` : path);
    },
    [path, pinnedAccountId, router],
  );

  const apply = (event: FormEvent) => {
    event.preventDefault();
    go(form);
  };

  /**
   * What is currently filtered, as one removable chip each.
   *
   * Built from the same `FormValues` the controls write, so a chip cannot
   * describe something the panel would not show - and removing one is just the
   * form with that field emptied, applied.
   */
  const chips: { key: string; label: string; without: FormValues }[] = [];
  const chip = (key: string, label: string, patch: Partial<FormValues>) =>
    chips.push({ key, label, without: { ...form, ...patch } });

  const nameOf = (list: { id: string; name: string }[], id: string, fallback: string) =>
    list.find((item) => item.id === id)?.name ?? fallback;

  if (form.q) chip('q', `“${form.q}”`, { q: '' });
  if (form.payee) chip('payee', `paid to “${form.payee}”`, { payee: '' });
  if (form.memo) chip('memo', `noted “${form.memo}”`, { memo: '' });
  if (form.envelopes[0]) {
    chip(
      'env',
      form.envelopes[0] === UNCATEGORIZED
        ? 'no envelope yet'
        : nameOf(envelopes, form.envelopes[0], 'an envelope'),
      { envelopes: [] },
    );
  }
  if (form.envelopeGroups[0]) {
    chip('envgroup', nameOf(envelopeGroups ?? [], form.envelopeGroups[0], 'a group'), {
      envelopeGroups: [],
    });
  }
  if (!pinnedAccountId && form.accounts[0] && form.accounts[0] !== everyAccountValue) {
    chip('account', nameOf(accounts, form.accounts[0], 'an account'), { accounts: [] });
  }
  if (form.accountGroups[0]) {
    chip('acctgroup', nameOf(accountGroups ?? [], form.accountGroups[0], 'a category'), {
      accountGroups: [],
    });
  }
  if (form.from) chip('from', `from ${displayDate(form.from)}`, { from: '' });
  if (form.to) chip('to', `to ${displayDate(form.to)}`, { to: '' });
  if (form.min) chip('min', `at least $${form.min}`, { min: '' });
  if (form.max) chip('max', `at most $${form.max}`, { max: '' });
  if (form.dir) chip('dir', form.dir === 'in' ? 'money in' : 'money out', { dir: '' });
  if (form.status) {
    chip('status', form.status === 'pending_review' ? 'awaiting review' : 'confirmed', {
      status: '',
    });
  }
  if (form.kind) {
    chip('kind', form.kind === 'account_transfer' ? 'transfers' : 'spending and income', {
      kind: '',
    });
  }

  const clear = () => {
    const blank: FormValues = {
      q: '',
      payee: '',
      memo: '',
      from: '',
      to: '',
      min: '',
      max: '',
      dir: '',
      status: '',
      kind: '',
      accounts: [],
      accountGroups: [],
      envelopes: [],
      envelopeGroups: [],
      sort: 'date',
      order: 'desc',
    };
    setForm(blank);
    router.push(pinnedAccountId ? `${path}?account=${pinnedAccountId}` : path);
  };

  // Grouped so a long envelope list is navigable; the pool sits with the rest
  // because filtering by it is a real question ("what came out of Available?").
  const groups = [...new Set(envelopes.map((envelope) => envelope.groupName))];

  return (
    <form className="filters" onSubmit={apply}>
      <div className="filter-main">
        <input
          type="search"
          className="filter-text"
          value={form.q}
          placeholder="Payee, memo or cheque number"
          onChange={(event) => set('q', event.target.value)}
          aria-label="Search text"
        />
        <button type="submit" className="primary">
          Search
        </button>
        <button type="button" className="link-button" onClick={() => setOpen(!open)}>
          {open ? 'Fewer filters' : 'More filters'}
        </button>
        {active && (
          <button type="button" className="link-button" onClick={clear}>
            Clear all
          </button>
        )}
      </div>

      {chips.length > 0 && (
        <div className="filter-chips">
          {chips.map((item) => (
            <button
              key={item.key}
              type="button"
              className="chip"
              onClick={() => {
                setForm(item.without);
                go(item.without);
              }}
              title={`Remove: ${item.label}`}
            >
              {item.label}
              <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}

      {open && (
        <div className="filter-grid">
          <label className="field">
            <span>From</span>
            <input
              type="date"
              value={form.from}
              onChange={(event) => set('from', event.target.value)}
            />
          </label>
          <label className="field">
            <span>To</span>
            <input type="date" value={form.to} onChange={(event) => set('to', event.target.value)} />
          </label>

          <label className="field">
            <span>At least</span>
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={form.min}
              onChange={(event) => set('min', event.target.value)}
            />
          </label>
          <label className="field">
            <span>At most</span>
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={form.max}
              onChange={(event) => set('max', event.target.value)}
            />
          </label>

          <label className="field">
            <span>Direction</span>
            <select value={form.dir} onChange={(event) => set('dir', event.target.value)}>
              <option value="">In or out</option>
              <option value="out">Money out</option>
              <option value="in">Money in</option>
            </select>
          </label>

          <label className="field">
            <span>Paid to</span>
            <input
              type="search"
              value={form.payee}
              placeholder="just the payee"
              onChange={(event) => set('payee', event.target.value)}
            />
          </label>
          <label className="field">
            <span>Note says</span>
            <input
              type="search"
              value={form.memo}
              placeholder="the memo or your note"
              onChange={(event) => set('memo', event.target.value)}
            />
          </label>

          {envelopeGroups && envelopeGroups.length > 0 && (
            <label className="field">
              <span>Envelope group</span>
              <select
                value={form.envelopeGroups[0] ?? ''}
                onChange={(event) =>
                  set('envelopeGroups', event.target.value ? [event.target.value] : [])
                }
              >
                <option value="">Any group</option>
                {envelopeGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="field">
            <span>Envelope</span>
            <select
              value={form.envelopes[0] ?? ''}
              onChange={(event) =>
                set('envelopes', event.target.value ? [event.target.value] : [])
              }
            >
              <option value="">Any envelope</option>
              <option value={UNCATEGORIZED}>No envelope yet</option>
              {groups.map((group) => (
                <optgroup key={group} label={group}>
                  {envelopes
                    .filter((envelope) => envelope.groupName === group)
                    .map((envelope) => (
                      <option key={envelope.id} value={envelope.id}>
                        {envelope.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>

          {!pinnedAccountId && accountGroups && accountGroups.length > 0 && (
            <label className="field">
              <span>Account category</span>
              <select
                value={form.accountGroups[0] ?? ''}
                onChange={(event) =>
                  set('accountGroups', event.target.value ? [event.target.value] : [])
                }
              >
                <option value="">Any category</option>
                {accountGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {!pinnedAccountId && (
            <label className="field">
              <span>Account</span>
              <select
                value={form.accounts[0] ?? ''}
                onChange={(event) =>
                  set('accounts', event.target.value ? [event.target.value] : [])
                }
              >
                <option value={everyAccountValue ?? ''}>Every account</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                    {account.archived ? ' (archived)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="field">
            <span>Status</span>
            <select value={form.status} onChange={(event) => set('status', event.target.value)}>
              <option value="">Any status</option>
              <option value="pending_review">Awaiting review</option>
              <option value="confirmed">Confirmed</option>
            </select>
          </label>

          <label className="field">
            <span>Kind</span>
            <select value={form.kind} onChange={(event) => set('kind', event.target.value)}>
              <option value="">Anything</option>
              <option value="spending">Spending and income</option>
              <option value="account_transfer">Transfers between accounts</option>
            </select>
          </label>

          <label className="field">
            <span>Sort by</span>
            <select value={form.sort} onChange={(event) => set('sort', event.target.value)}>
              <option value="date">Date</option>
              <option value="amount">Size</option>
              <option value="payee">Payee</option>
            </select>
          </label>

          <label className="field">
            <span>Order</span>
            <select value={form.order} onChange={(event) => set('order', event.target.value)}>
              <option value="desc">Biggest or newest first</option>
              <option value="asc">Smallest or oldest first</option>
            </select>
          </label>

          <div className="filter-apply">
            <button type="submit" className="primary">
              Apply
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
