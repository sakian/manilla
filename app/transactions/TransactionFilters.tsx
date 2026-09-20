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

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { UNCATEGORIZED } from '../../src/transactions/search.ts';
import { writeQuery, type FormValues } from '../search/urlQuery.ts';

export type FilterChoice = { id: string; name: string; archived?: boolean };
export type EnvelopeFilterChoice = { id: string; name: string; groupName: string };

export default function TransactionFilters({
  path,
  values,
  accounts,
  envelopes,
  pinnedAccountId,
  active,
}: {
  /** Where to navigate: `/search`, or the account view. */
  path: string;
  values: FormValues;
  accounts: FilterChoice[];
  envelopes: EnvelopeFilterChoice[];
  /** Set on the account view, where the account is the page rather than a filter. */
  pinnedAccountId?: string;
  /** Whether anything is currently being filtered, so "Clear" can be hidden. */
  active: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState<FormValues>(values);
  const [open, setOpen] = useState(active);

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const apply = (event: FormEvent) => {
    event.preventDefault();
    const query = writeQuery({
      ...form,
      // The pinned account travels as the same `account` param, so a link from
      // here to the full search keeps the account filter it was showing.
      accounts: pinnedAccountId ? [pinnedAccountId] : form.accounts,
    });
    router.push(query ? `${path}?${query}` : path);
  };

  const clear = () => {
    const blank: FormValues = {
      q: '',
      from: '',
      to: '',
      min: '',
      max: '',
      dir: '',
      status: '',
      kind: '',
      accounts: [],
      envelopes: [],
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
            Clear
          </button>
        )}
      </div>

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

          {!pinnedAccountId && (
            <label className="field">
              <span>Account</span>
              <select
                value={form.accounts[0] ?? ''}
                onChange={(event) =>
                  set('accounts', event.target.value ? [event.target.value] : [])
                }
              >
                <option value="">Every account</option>
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
