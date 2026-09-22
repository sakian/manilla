'use client';

/**
 * Reports (RP-1, RP-2, RP-6).
 *
 * Tables rather than charts, deliberately for now: the numbers are the point,
 * and a table can be read, sorted by eye, and downloaded. A trend does eventually
 * want a shape rather than a grid, but that is a drawing problem to solve once
 * the figures are right.
 *
 * The period lives in the URL, so a report can be bookmarked, reloaded and
 * linked, and the CSV downloads carry the same dates rather than a second idea
 * of what was being looked at.
 */

import { useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type {
  Period,
  ReportTransaction,
  SpendingReport,
  TrendReport,
} from '../../src/reports/reports.ts';
import { Hint } from '../Hint.tsx';
import { Money } from '../Money.tsx';
import { formatMoney } from '../../src/money.ts';
import { displayDate } from '../../src/budget/month.ts';

const PRESETS: { key: string; label: string }[] = [
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'this-year', label: 'This year' },
  { key: 'last-12-months', label: 'Last 12 months' },
  { key: 'all-time', label: 'All time' },
];

function monthLabel(month: string): string {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [year, index] = month.split('-');
  return `${names[Number(index) - 1]} ${year!.slice(2)}`;
}

export default function ReportScreen({
  period,
  preset,
  spending,
  trend,
  drilldown,
  drilldownEnvelopeId,
}: {
  period: Period;
  preset: string | null;
  spending: SpendingReport;
  trend: TrendReport;
  drilldown: ReportTransaction[];
  drilldownEnvelopeId: string | null;
}) {
  const router = useRouter();
  const search = useSearchParams();
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);

  const go = useCallback(
    (next: Record<string, string | null>) => {
      const params = new URLSearchParams(search.toString());
      for (const [key, value] of Object.entries(next)) {
        if (value === null) params.delete(key);
        else params.set(key, value);
      }
      router.push(`/reports?${params.toString()}`);
    },
    [router, search],
  );

  const csv = (report: string) => {
    const params = new URLSearchParams({ report, from: period.from, to: period.to });
    if (report === 'transactions' && drilldownEnvelopeId) {
      params.set('envelope', drilldownEnvelopeId);
    }
    return `/api/reports?${params.toString()}`;
  };

  const openEnvelope = spending.groups
    .flatMap((group) => group.envelopes)
    .find((envelope) => envelope.envelopeId === drilldownEnvelopeId);

  return (
    <>
      <div className="page-head">
        <h2>
          Reports{' '}
          <Hint label="What counts as spending here">
          Spending only: transfers between your accounts and moves between envelopes are not
          spending and never appear here, and a split counts at each envelope&rsquo;s own share
            (RP-5).
          </Hint>
        </h2>
      </div>

      <div className="segmented periods">
        {PRESETS.map((item) => (
          <button
            key={item.key}
            className={preset === item.key ? 'active' : ''}
            onClick={() => go({ preset: item.key, from: null, to: null, envelope: null })}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="period-custom">
        <label className="field inline">
          <span>From</span>
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label className="field inline">
          <span>To</span>
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
        <button onClick={() => go({ from, to, preset: null, envelope: null })}>Show it</button>
      </div>

      <div className="callouts">
        <div className="callout">
          Spent <strong>{formatMoney(spending.totalCents)}</strong>
        </div>
        <div className="callout">
          {displayDate(period.from)} to {displayDate(period.to)}
        </div>
        <div className="callout">
          {spending.envelopeCount} envelope{spending.envelopeCount === 1 ? '' : 's'} used
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h3>By envelope</h3>
          <a className="button-link" href={csv('spending')} download>
            CSV
          </a>
        </div>

        {spending.groups.length === 0 && (
          <p className="muted">Nothing was spent in that period.</p>
        )}

        <div className="budget-table">
          {spending.groups.map((group) => (
            <div key={group.groupId}>
              <div className="budget-group">
                <span>{group.name}</span>
                <span className="money">{formatMoney(group.spentCents)}</span>
              </div>
              {group.envelopes.map((envelope) => {
                const share =
                  spending.totalCents > 0
                    ? Math.round((envelope.spentCents / spending.totalCents) * 100)
                    : 0;
                return (
                  <div key={envelope.envelopeId} className="budget-row report">
                    <span>
                      <button
                        className="link-button"
                        onClick={() => go({ envelope: envelope.envelopeId })}
                      >
                        {envelope.name}
                      </button>
                    </span>
                    <span className="money">{formatMoney(envelope.spentCents)}</span>
                    <span className="muted">{share}%</span>
                    <span className="muted">
                      {envelope.transactionCount}{' '}
                      {envelope.transactionCount === 1 ? 'transaction' : 'transactions'}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}

          {spending.groups.length > 0 && (
            <div className="budget-row report total">
              <span>Total</span>
              <span className="money">{formatMoney(spending.totalCents)}</span>
              <span />
              <span />
            </div>
          )}
        </div>
      </section>

      {drilldownEnvelopeId && (
        <section className="panel">
          <div className="panel-head">
            <h3>{openEnvelope?.name ?? 'Envelope'} in this period</h3>
            <span>
              <a className="button-link" href={csv('transactions')} download>
                CSV
              </a>{' '}
              <button className="link-button" onClick={() => go({ envelope: null })}>
                close
              </button>
            </span>
          </div>

          {drilldown.length === 0 && <p className="muted">Nothing in this period.</p>}

          {drilldown.map((row) => (
            <div key={`${row.id}-${row.envelope}`} className="txn">
              <span className="txn-payee">{row.payeeRaw}</span>
              <Money cents={row.shareCents} />
              <span className="muted txn-meta">
                <span className="txn-date">{displayDate(row.date)}</span>
                <span className="txn-env">
                  {row.account}
                  {row.shareCents !== row.amountCents && ' · part of a split'}
                  {row.status === 'pending_review' && ' · pending'}
                </span>
              </span>
            </div>
          ))}
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <h3>Month by month</h3>
          <a className="button-link" href={csv('trend')} download>
            CSV
          </a>
        </div>

        {trend.months.length === 0 ? (
          <p className="muted">That period does not cover a month.</p>
        ) : (
          <div className="trend-scroll">
            <table className="trend">
              <thead>
                <tr>
                  <th>Envelope</th>
                  {trend.months.map((month) => (
                    <th key={month}>{monthLabel(month)}</th>
                  ))}
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {trend.rows.map((row) => (
                  <tr key={row.envelopeId}>
                    <td>
                      <button className="link-button" onClick={() => go({ envelope: row.envelopeId })}>
                        {row.name}
                      </button>
                    </td>
                    {row.byMonth.map((cents, at) => (
                      <td key={trend.months[at]} className="money">
                        {cents === 0 ? <span className="muted">–</span> : formatMoney(cents)}
                      </td>
                    ))}
                    <td className="money">{formatMoney(row.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>All envelopes</td>
                  {trend.totalsByMonth.map((cents, at) => (
                    <td key={trend.months[at]} className="money">
                      {formatMoney(cents)}
                    </td>
                  ))}
                  <td className="money">{formatMoney(trend.totalCents)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <p className="muted footnote">
          The twelve busiest envelopes are shown; the totals row counts every one of them. Download
          the CSV for the full list, or <Link href="/envelopes">open an envelope</Link> for its own
          history.
        </p>
      </section>
    </>
  );
}
